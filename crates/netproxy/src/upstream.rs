//! Opening a tunnel to a destination through the upstream proxy.
//!
//! - HTTP / HTTPS proxies: `CONNECT host:port` (over TLS for HTTPS proxies). A login, when saved, is sent as
//!   `Proxy-Authorization: Basic …` with the request itself — only to this proxy. A `407` reply is never passed to
//!   the browser (it would prompt for a password); it becomes an error code instead.
//! - SOCKS5: no-login or username/password (RFC 1929); the destination is sent as a domain name, so the proxy
//!   resolves it.
//!
//! The proxy's own address is resolved here and every resolved address is checked against the address policy before
//! connecting (a name cannot be used to reach a forbidden address).

use crate::tls::TlsTrust;
use crate::{
    CONNECT_TIMEOUT, Credentials, HANDSHAKE_TIMEOUT, ProxyError, ProxyKind, Target, Upstream,
    address_allowed,
};
use base64::Engine;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// A bidirectional byte stream (TCP, TLS over TCP, or a tunnel).
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type BoxIo = Box<dyn Io>;

/// Longest proxy response head accepted.
const MAX_RESPONSE_HEAD: usize = 16 * 1024;

/// Resolves the proxy's address and connects, trying each allowed address in turn.
pub async fn dial(up: &Upstream) -> Result<TcpStream, ProxyError> {
    let addrs: Vec<SocketAddr> = match up.host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, up.port)],
        Err(_) => timeout(
            CONNECT_TIMEOUT,
            tokio::net::lookup_host((up.host.as_str(), up.port)),
        )
        .await
        .map_err(|_| ProxyError::DnsFailed)?
        .map_err(|_| ProxyError::DnsFailed)?
        .collect(),
    };
    if addrs.is_empty() {
        return Err(ProxyError::DnsFailed);
    }
    let mut last = ProxyError::Unreachable;
    for addr in addrs {
        if let Err(e) = address_allowed(addr.ip(), up.policy) {
            last = e;
            continue;
        }
        match timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(_)) => last = ProxyError::Unreachable,
            Err(_) => last = ProxyError::Timeout,
        }
    }
    Err(last)
}

/// Connects to the proxy itself (TLS for HTTPS proxies).
pub async fn open(up: &Upstream, trust: &TlsTrust) -> Result<BoxIo, ProxyError> {
    let tcp = dial(up).await?;
    match up.kind {
        ProxyKind::Https => {
            let tls = timeout(HANDSHAKE_TIMEOUT, crate::tls::connect(trust, &up.host, tcp))
                .await
                .map_err(|_| ProxyError::Timeout)??;
            Ok(Box::new(tls))
        }
        ProxyKind::Http | ProxyKind::Socks5 => Ok(Box::new(tcp)),
    }
}

/// Opens a tunnel to `target` through the proxy.
pub async fn connect_via(
    up: &Upstream,
    trust: &TlsTrust,
    target: &Target,
) -> Result<BoxIo, ProxyError> {
    let mut io = open(up, trust).await?;
    let result = timeout(HANDSHAKE_TIMEOUT, async {
        match up.kind {
            ProxyKind::Http | ProxyKind::Https => {
                http_connect(&mut io, up.credentials.as_ref(), target).await
            }
            ProxyKind::Socks5 => socks5_connect(&mut io, up.credentials.as_ref(), target).await,
        }
    })
    .await
    .map_err(|_| ProxyError::Timeout)?;
    let leftover = result?;
    Ok(if leftover.is_empty() {
        io
    } else {
        Box::new(Prefixed::new(leftover, io))
    })
}

pub fn basic_auth(c: &Credentials) -> String {
    let token =
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", c.username, c.password));
    format!("Basic {token}")
}

/// Reads an HTTP head (up to the blank line). Returns the head and any bytes read past it.
pub async fn read_head<S: AsyncRead + Unpin>(
    s: &mut S,
    limit: usize,
) -> Result<(Vec<u8>, Vec<u8>), ProxyError> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        if let Some(end) = find_blank_line(&buf) {
            let rest = buf.split_off(end);
            return Ok((buf, rest));
        }
        if buf.len() > limit {
            return Err(ProxyError::Protocol("response head too large".into()));
        }
        let n = s
            .read(&mut chunk)
            .await
            .map_err(|_| ProxyError::Unreachable)?;
        if n == 0 {
            return Err(if buf.is_empty() {
                ProxyError::Unreachable
            } else {
                ProxyError::Protocol("connection closed mid-response".into())
            });
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Index just past `\r\n\r\n`.
pub fn find_blank_line(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Status code and `Proxy-Authenticate` schemes of a response head.
pub fn parse_response_head(head: &[u8]) -> Result<(u16, Vec<String>), ProxyError> {
    let text = std::str::from_utf8(head).map_err(|_| ProxyError::Protocol("not HTTP".into()))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/1.") {
        return Err(ProxyError::Protocol("not an HTTP proxy".into()));
    }
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ProxyError::Protocol("bad status line".into()))?;
    let mut schemes = vec![];
    for line in lines {
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("proxy-authenticate")
            && let Some(scheme) = value.split_whitespace().next()
        {
            schemes.push(scheme.trim_end_matches(',').to_ascii_lowercase());
        }
    }
    Ok((status, schemes))
}

/// What a `407` means for us.
pub fn auth_error(sent_credentials: bool, schemes: &[String]) -> ProxyError {
    let basic = schemes.iter().any(|s| s == "basic");
    match (sent_credentials, basic) {
        (true, true) => ProxyError::AuthFailed,
        (false, true) => ProxyError::AuthRequired,
        (_, false) if schemes.is_empty() => {
            if sent_credentials {
                ProxyError::AuthFailed
            } else {
                ProxyError::AuthRequired
            }
        }
        (_, false) => ProxyError::AuthUnsupported(schemes.join(", ")),
    }
}

/// Maps a non-2xx answer to a tunnel/forward request.
pub fn status_error(status: u16, sent_credentials: bool, schemes: &[String]) -> ProxyError {
    match status {
        407 => auth_error(sent_credentials, schemes),
        403 | 405 => ProxyError::TargetBlocked,
        404 | 502 | 503 | 504 => ProxyError::TargetFailed,
        _ => ProxyError::Protocol(format!("HTTP {status}")),
    }
}

async fn http_connect(
    io: &mut BoxIo,
    creds: Option<&Credentials>,
    target: &Target,
) -> Result<Vec<u8>, ProxyError> {
    let authority = target.authority();
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(c) = creds {
        req.push_str(&format!("Proxy-Authorization: {}\r\n", basic_auth(c)));
    }
    req.push_str("\r\n");
    io.write_all(req.as_bytes())
        .await
        .map_err(|_| ProxyError::Unreachable)?;
    io.flush().await.map_err(|_| ProxyError::Unreachable)?;
    let (head, rest) = read_head(io, MAX_RESPONSE_HEAD).await?;
    let (status, schemes) = parse_response_head(&head)?;
    if (200..300).contains(&status) {
        Ok(rest)
    } else {
        Err(status_error(status, creds.is_some(), &schemes))
    }
}

async fn socks5_connect(
    io: &mut BoxIo,
    creds: Option<&Credentials>,
    target: &Target,
) -> Result<Vec<u8>, ProxyError> {
    let io_err = |_| ProxyError::Unreachable;
    let greeting: &[u8] = if creds.is_some() {
        &[5, 2, 0, 2]
    } else {
        &[5, 1, 0]
    };
    io.write_all(greeting).await.map_err(io_err)?;
    let mut choice = [0u8; 2];
    io.read_exact(&mut choice).await.map_err(io_err)?;
    if choice[0] != 5 {
        return Err(ProxyError::Protocol("not a SOCKS5 proxy".into()));
    }
    match (choice[1], creds) {
        (0, _) => {}
        (2, Some(c)) => {
            let (u, p) = (c.username.as_bytes(), c.password.as_bytes());
            let (Ok(ul), Ok(pl)) = (u8::try_from(u.len()), u8::try_from(p.len())) else {
                return Err(ProxyError::AuthFailed);
            };
            let mut msg = vec![1, ul];
            msg.extend_from_slice(u);
            msg.push(pl);
            msg.extend_from_slice(p);
            io.write_all(&msg).await.map_err(io_err)?;
            let mut status = [0u8; 2];
            io.read_exact(&mut status).await.map_err(io_err)?;
            if status[1] != 0 {
                return Err(ProxyError::AuthFailed);
            }
        }
        (2, None) | (0xFF, None) => return Err(ProxyError::AuthRequired),
        (0xFF, Some(_)) => {
            return Err(ProxyError::AuthUnsupported(
                "the proxy accepts neither no login nor username/password".into(),
            ));
        }
        (1, _) => return Err(ProxyError::AuthUnsupported("GSSAPI".into())),
        (m, _) => return Err(ProxyError::AuthUnsupported(format!("method {m}"))),
    }
    let mut req = vec![5, 1, 0];
    match target.host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            req.push(1);
            req.extend_from_slice(&v4.octets());
        }
        Ok(IpAddr::V6(v6)) => {
            req.push(4);
            req.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            let name = target.host.as_bytes();
            let len = u8::try_from(name.len()).map_err(|_| ProxyError::TargetFailed)?;
            req.push(3);
            req.push(len);
            req.extend_from_slice(name);
        }
    }
    req.extend_from_slice(&target.port.to_be_bytes());
    io.write_all(&req).await.map_err(io_err)?;
    let mut reply = [0u8; 4];
    io.read_exact(&mut reply).await.map_err(io_err)?;
    if reply[0] != 5 {
        return Err(ProxyError::Protocol("bad SOCKS5 reply".into()));
    }
    let skip = match reply[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut l = [0u8; 1];
            io.read_exact(&mut l).await.map_err(io_err)?;
            usize::from(l[0]) + 2
        }
        _ => return Err(ProxyError::Protocol("bad SOCKS5 address type".into())),
    };
    let mut bound = vec![0u8; skip];
    io.read_exact(&mut bound).await.map_err(io_err)?;
    match reply[1] {
        0 => Ok(vec![]),
        2 => Err(ProxyError::TargetBlocked),
        1 | 3..=6 => Err(ProxyError::TargetFailed),
        7 | 8 => Err(ProxyError::Protocol(
            "the proxy does not support this request".into(),
        )),
        _ => Err(ProxyError::Protocol("unknown SOCKS5 reply".into())),
    }
}

/// A stream that yields `prefix` before reading from `inner` (bytes read past a handshake).
pub struct Prefixed<S> {
    prefix: Vec<u8>,
    pos: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            pos: 0,
            inner,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.pos < self.prefix.len() {
            let n = (self.prefix.len() - self.pos).min(buf.remaining());
            let start = self.pos;
            buf.put_slice(&self.prefix[start..start + n]);
            self.pos += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_heads() {
        let head = b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Digest realm=\"x\", nonce=\"y\"\r\nProxy-Authenticate: NTLM\r\n\r\n";
        let (status, schemes) = parse_response_head(head).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            (status, schemes.clone()),
            (407, vec!["digest".to_owned(), "ntlm".to_owned()])
        );
        assert_eq!(
            status_error(407, true, &schemes),
            ProxyError::AuthUnsupported("digest, ntlm".into())
        );
        assert_eq!(
            status_error(407, true, &["basic".into()]),
            ProxyError::AuthFailed
        );
        assert_eq!(
            status_error(407, false, &["basic".into()]),
            ProxyError::AuthRequired
        );
        assert_eq!(status_error(403, false, &[]), ProxyError::TargetBlocked);
        assert_eq!(status_error(502, false, &[]), ProxyError::TargetFailed);
        assert!(matches!(
            parse_response_head(b"SSH-2.0-OpenSSH\r\n\r\n"),
            Err(ProxyError::Protocol(_))
        ));
    }

    #[test]
    fn basic_header() {
        let c = Credentials {
            username: "Aladdin".into(),
            password: "open sesame".into(),
        };
        assert_eq!(basic_auth(&c), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    }
}
