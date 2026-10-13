//! The loopback gateway a profile's browser uses as its proxy (`--proxy-server=http://127.0.0.1:<port>`).
//!
//! It listens on 127.0.0.1 only. With [`Fallback::Block`] (fail-closed, the default) it has no direct route anywhere:
//! every request goes through the profile's upstream proxy, or fails. With [`Fallback::Direct`] (the user turned
//! fail-closed off) a connection whose proxy cannot be reached at all is made directly instead, and counted in
//! [`GatewayStatus::direct_connections`] so the manager can say so; login, TLS, address-policy and website errors
//! never fall back. Browser requests are handled as:
//! - `CONNECT host:port` (https, wss and ws through a proxy): tunnel via the upstream, then relay bytes;
//! - absolute-form `GET http://host/…` (plain http): forwarded through the upstream with `Connection: close`;
//! - anything else: `400`.
//!
//! When the upstream fails, the browser gets `502` (it shows a connection error) and the failure is recorded in
//! [`GatewayStatus`] for the manager to show; a `407` from the upstream never reaches the browser.
//!
//! Other programs on this computer, running as the same user, could also connect to the loopback port while the
//! profile is open. That is accepted in the threat model: such programs can already read the profile's data.

use crate::tls::TlsTrust;
use crate::upstream::{self, BoxIo};
use crate::{CONNECT_TIMEOUT, NetRuntime, ProxyError, ProxyKind, Target, Upstream};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncWriteExt, copy_bidirectional};
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, watch};
use tokio::time::timeout;

/// Most simultaneous browser connections per gateway (Chromium itself uses at most 32 per proxy).
pub const MAX_CONNECTIONS: usize = 256;
const MAX_REQUEST_HEAD: usize = 32 * 1024;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Waiting for a website's answer to a plain-http request forwarded through an HTTP proxy.
const RESPONSE_HEAD_TIMEOUT: Duration = Duration::from_secs(120);

/// What the gateway does when the upstream proxy cannot be reached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Fallback {
    /// Fail closed: the request fails and nothing is sent without the proxy.
    #[default]
    Block,
    /// Fail open: when the proxy itself cannot be reached (its name, its address, or no answer in time), connect
    /// directly instead. Never used for login, TLS, address-policy or website errors.
    Direct,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct GatewayStatus {
    pub port: u16,
    pub connections: u64,
    pub active: u64,
    pub failures: u64,
    /// Failures since the last success; > 0 means the proxy is failing right now.
    pub consecutive_failures: u64,
    /// Connections made without the proxy (only with [`Fallback::Direct`]).
    pub direct_connections: u64,
    /// Websites the proxy answered it could not reach (the proxy itself worked).
    pub website_errors: u64,
    pub last_error: Option<&'static str>,
    pub last_error_at: Option<SystemTime>,
    pub last_success_at: Option<SystemTime>,
    pub last_direct_at: Option<SystemTime>,
}

#[derive(Clone, Copy, Default)]
struct Last {
    error: Option<&'static str>,
    error_at: Option<SystemTime>,
    success_at: Option<SystemTime>,
    direct_at: Option<SystemTime>,
}

#[derive(Default)]
struct Stats {
    connections: AtomicU64,
    active: AtomicU64,
    failures: AtomicU64,
    consecutive: AtomicU64,
    direct: AtomicU64,
    website: AtomicU64,
    last: Mutex<Last>,
}

impl Stats {
    fn ok(&self) {
        self.consecutive.store(0, Ordering::Relaxed);
        if let Ok(mut l) = self.last.lock() {
            l.success_at = Some(SystemTime::now());
        }
    }
    /// Records a failed connection. A website the proxy could not reach does not make the proxy "failing".
    fn fail(&self, e: &ProxyError) {
        if e.is_website_error() {
            self.ok();
            self.website.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.failures.fetch_add(1, Ordering::Relaxed);
        self.consecutive.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut l) = self.last.lock() {
            l.error = Some(e.code());
            l.error_at = Some(SystemTime::now());
        }
    }
    fn direct(&self) {
        self.direct.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut l) = self.last.lock() {
            l.direct_at = Some(SystemTime::now());
        }
    }
}

struct Config {
    upstream: Upstream,
    trust: TlsTrust,
    fallback: Fallback,
}

pub struct Gateway {
    port: u16,
    stats: Arc<Stats>,
    shutdown: watch::Sender<bool>,
}

impl Gateway {
    /// Starts a fail-closed gateway on `127.0.0.1:bind_port` (0 = any free port).
    pub fn start(
        net: &NetRuntime,
        bind_port: u16,
        upstream: Upstream,
        trust: TlsTrust,
    ) -> std::io::Result<Self> {
        Self::start_with(net, bind_port, upstream, trust, Fallback::Block)
    }

    /// Starts listening on `127.0.0.1:bind_port` (0 = any free port) with the given fallback.
    pub fn start_with(
        net: &NetRuntime,
        bind_port: u16,
        upstream: Upstream,
        trust: TlsTrust,
        fallback: Fallback,
    ) -> std::io::Result<Self> {
        let listener =
            std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, bind_port)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stats = Arc::new(Stats::default());
        let (tx, rx) = watch::channel(false);
        let config = Arc::new(Config {
            upstream,
            trust,
            fallback,
        });
        let task_stats = stats.clone();
        net.handle().spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                return;
            };
            let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
            let mut stop = rx.clone();
            loop {
                let permit = tokio::select! {
                    _ = stop.changed() => break,
                    p = permits.clone().acquire_owned() => match p { Ok(p) => p, Err(_) => break },
                };
                let (client, peer) = tokio::select! {
                    _ = stop.changed() => break,
                    r = listener.accept() => match r { Ok(c) => c, Err(_) => continue },
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let config = config.clone();
                let stats = task_stats.clone();
                let mut stop = rx.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    stats.connections.fetch_add(1, Ordering::Relaxed);
                    stats.active.fetch_add(1, Ordering::Relaxed);
                    tokio::select! {
                        _ = stop.changed() => {}
                        _ = serve(client, &config, &stats) => {}
                    }
                    stats.active.fetch_sub(1, Ordering::Relaxed);
                });
            }
        });
        Ok(Self {
            port,
            stats,
            shutdown: tx,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn status(&self) -> GatewayStatus {
        let last = self.stats.last.lock().map(|l| *l).unwrap_or_default();
        GatewayStatus {
            port: self.port,
            connections: self.stats.connections.load(Ordering::Relaxed),
            active: self.stats.active.load(Ordering::Relaxed),
            failures: self.stats.failures.load(Ordering::Relaxed),
            consecutive_failures: self.stats.consecutive.load(Ordering::Relaxed),
            direct_connections: self.stats.direct.load(Ordering::Relaxed),
            website_errors: self.stats.website.load(Ordering::Relaxed),
            last_error: last.error,
            last_error_at: last.error_at,
            last_success_at: last.success_at,
            last_direct_at: last.direct_at,
        }
    }

    /// Stops listening and closes every relayed connection.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn serve(mut client: TcpStream, config: &Config, stats: &Stats) {
    let (up, trust) = (&config.upstream, &config.trust);
    let _ = client.set_nodelay(true);
    let Ok(Ok((head, rest))) = timeout(
        REQUEST_HEAD_TIMEOUT,
        upstream::read_head(&mut client, MAX_REQUEST_HEAD),
    )
    .await
    else {
        return;
    };
    let Some(req) = Request::parse(&head) else {
        let _ = client
            .write_all(&plain_response(400, "Bad Request", None))
            .await;
        return;
    };
    if req.method == "CONNECT" {
        let Some(target) = Target::parse_authority(req.target) else {
            let _ = client
                .write_all(&plain_response(400, "Bad Request", None))
                .await;
            return;
        };
        let tunnel = match upstream::connect_via(up, trust, &target).await {
            Ok(t) => {
                stats.ok();
                Ok(t)
            }
            Err(e) => {
                stats.fail(&e);
                fall_back(config, &target, e, stats).await
            }
        };
        match tunnel {
            Ok(mut tunnel) => {
                if client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .is_err()
                {
                    return;
                }
                if !rest.is_empty() && tunnel.write_all(&rest).await.is_err() {
                    return;
                }
                let _ = copy_bidirectional(&mut client, &mut tunnel).await;
            }
            Err(e) => {
                let _ = client
                    .write_all(&plain_response(502, "Bad Gateway", Some(&e)))
                    .await;
            }
        }
        return;
    }
    let Some((target, path)) = absolute_http(req.target) else {
        let _ = client
            .write_all(&plain_response(400, "Bad Request", None))
            .await;
        return;
    };
    let forwarded = match forward_http(up, trust, &req, &target, &path, &head, &rest).await {
        Ok(f) => {
            stats.ok();
            Ok(f)
        }
        Err(e) => {
            stats.fail(&e);
            match fall_back(config, &target, e, stats).await {
                Ok(io) => send_origin_form(io, &req, &path, &head, &rest)
                    .await
                    .map(|io| (io, vec![])),
                Err(e) => Err(e),
            }
        }
    };
    match forwarded {
        Ok((mut upstream_io, response_prefix)) => {
            if client.write_all(&response_prefix).await.is_err() {
                return;
            }
            let _ = copy_bidirectional(&mut client, &mut upstream_io).await;
        }
        Err(e) => {
            let _ = client
                .write_all(&plain_response(502, "Bad Gateway", Some(&e)))
                .await;
        }
    }
}

/// With [`Fallback::Direct`] and a proxy that cannot be reached at all, connects to the website directly. Otherwise
/// (and when the direct connection fails too) returns the proxy's error.
async fn fall_back(
    config: &Config,
    target: &Target,
    error: ProxyError,
    stats: &Stats,
) -> Result<BoxIo, ProxyError> {
    if config.fallback != Fallback::Direct || !error.proxy_unreachable() {
        return Err(error);
    }
    match timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((target.host.as_str(), target.port)),
    )
    .await
    {
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            stats.direct();
            Ok(Box::new(s))
        }
        _ => Err(error),
    }
}

/// Sends a plain-http request in origin form (`GET /path HTTP/1.1`) over a connection to the website itself.
async fn send_origin_form(
    mut io: BoxIo,
    req: &Request<'_>,
    path: &str,
    head: &[u8],
    rest: &[u8],
) -> Result<BoxIo, ProxyError> {
    let out = format!(
        "{} {} {}\r\n{}Connection: close\r\n\r\n",
        req.method,
        path,
        req.version,
        forwarded_headers(head)
    );
    io.write_all(out.as_bytes())
        .await
        .map_err(|_| ProxyError::TargetFailed)?;
    io.write_all(rest)
        .await
        .map_err(|_| ProxyError::TargetFailed)?;
    Ok(io)
}

/// Forwards one plain-http request. Returns the upstream stream and the bytes to send to the browser first.
async fn forward_http(
    up: &Upstream,
    trust: &TlsTrust,
    req: &Request<'_>,
    target: &Target,
    path: &str,
    head: &[u8],
    rest: &[u8],
) -> Result<(BoxIo, Vec<u8>), ProxyError> {
    match up.kind {
        ProxyKind::Http | ProxyKind::Https => {
            let headers = forwarded_headers(head);
            let mut io = upstream::open(up, trust).await?;
            // Port 80 is left implicit, as browsers write it.
            let authority = match (target.port, target.host.contains(':')) {
                (80, true) => format!("[{}]", target.host),
                (80, false) => target.host.clone(),
                _ => target.authority(),
            };
            let mut out = format!(
                "{} http://{}{} {}\r\n{}",
                req.method, authority, path, req.version, headers
            );
            if let Some(c) = &up.credentials {
                out.push_str(&format!(
                    "Proxy-Authorization: {}\r\n",
                    upstream::basic_auth(c)
                ));
            }
            out.push_str("Connection: close\r\n\r\n");
            io.write_all(out.as_bytes())
                .await
                .map_err(|_| ProxyError::Unreachable)?;
            io.write_all(rest)
                .await
                .map_err(|_| ProxyError::Unreachable)?;
            let (resp_head, resp_rest) = timeout(
                RESPONSE_HEAD_TIMEOUT,
                upstream::read_head(&mut io, MAX_REQUEST_HEAD),
            )
            .await
            .map_err(|_| ProxyError::Timeout)??;
            let (status, schemes) = upstream::parse_response_head(&resp_head)?;
            if status == 407 {
                return Err(upstream::auth_error(up.credentials.is_some(), &schemes));
            }
            let mut prefix = resp_head;
            prefix.extend_from_slice(&resp_rest);
            Ok((io, prefix))
        }
        ProxyKind::Socks5 => {
            let io = upstream::connect_via(up, trust, target).await?;
            Ok((send_origin_form(io, req, path, head, rest).await?, vec![]))
        }
    }
}

struct Request<'a> {
    method: &'a str,
    target: &'a str,
    version: &'a str,
}

impl<'a> Request<'a> {
    fn parse(head: &'a [u8]) -> Option<Self> {
        let text = std::str::from_utf8(head).ok()?;
        let line = text.split("\r\n").next()?;
        let mut parts = line.split(' ');
        let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some()
            || !matches!(version, "HTTP/1.1" | "HTTP/1.0")
            || method.is_empty()
            || !method.bytes().all(|b| b.is_ascii_uppercase())
            || target.is_empty()
            || target.bytes().any(|b| b.is_ascii_control())
        {
            return None;
        }
        Some(Self {
            method,
            target,
            version,
        })
    }
}

/// `http://host[:port]/path?q` → (target, "/path?q"). Logins in URLs and other schemes are refused.
fn absolute_http(target: &str) -> Option<(Target, String)> {
    let lower = target.get(..7)?.to_ascii_lowercase();
    if lower != "http://" {
        return None;
    }
    let rest = &target[7..];
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], rest[i..].to_owned()),
        None => (rest, "/".to_owned()),
    };
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let path = if path.starts_with('?') {
        format!("/{path}")
    } else {
        path
    };
    let with_port = if authority.ends_with(']') || !authority.contains(':') {
        format!("{authority}:80")
    } else {
        authority.to_owned()
    };
    Some((Target::parse_authority(&with_port)?, path))
}

/// The browser's headers minus hop-by-hop and proxy headers (each line ends with CRLF).
fn forwarded_headers(head: &[u8]) -> String {
    let text = String::from_utf8_lossy(head);
    let mut out = String::new();
    for line in text.split("\r\n").skip(1) {
        let Some((name, _)) = line.split_once(':') else {
            continue;
        };
        let n = name.trim().to_ascii_lowercase();
        if matches!(
            n.as_str(),
            "proxy-authorization"
                | "proxy-connection"
                | "connection"
                | "keep-alive"
                | "te"
                | "upgrade"
        ) {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out
}

/// A short response for the browser. For a failed proxy it explains that traffic was blocked, not sent directly.
fn plain_response(status: u16, reason: &str, error: Option<&ProxyError>) -> Vec<u8> {
    let (code, message) = match error {
        Some(e) => (e.code(), e.to_string()),
        None => (
            "BAD_REQUEST",
            "This request cannot be sent through the proxy.".to_owned(),
        ),
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Proxy connection failed</title>\
         <h1>The profile's proxy did not work</h1><p>{}.</p>\
         <p>Nothing was sent without the proxy. Check the proxy in Project Browser ({code}).</p>",
        html_escape(&message)
    );
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\nX-Pb-Error: {code}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_lines() {
        let r = Request::parse(b"CONNECT example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(
            r.map(|r| (r.method, r.target)),
            Some(("CONNECT", "example.com:443"))
        );
        for bad in [
            &b"GET / HTTP/2\r\n\r\n"[..],
            b"get http://a/ HTTP/1.1\r\n\r\n",
            b"GET  HTTP/1.1\r\n\r\n",
            b"GET http://a/ HTTP/1.1 extra\r\n\r\n",
        ] {
            assert!(
                Request::parse(bad).is_none(),
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn absolute_targets() {
        let (t, p) = absolute_http("http://Example.com/a/b?c=1").unwrap_or_else(|| panic!("parse"));
        assert_eq!(
            (t.authority(), p.as_str()),
            ("example.com:80".to_owned(), "/a/b?c=1")
        );
        let (t, p) = absolute_http("http://example.com:8080").unwrap_or_else(|| panic!("parse"));
        assert_eq!(
            (t.authority(), p.as_str()),
            ("example.com:8080".to_owned(), "/")
        );
        let (t, _) = absolute_http("http://[::1]/x").unwrap_or_else(|| panic!("parse"));
        assert_eq!(t.authority(), "[::1]:80");
        for bad in [
            "https://example.com/",
            "http://user:pw@example.com/",
            "/relative",
            "http:///x",
        ] {
            assert!(absolute_http(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn hop_by_hop_headers_are_dropped() {
        let head = b"GET http://a/ HTTP/1.1\r\nHost: a\r\nProxy-Authorization: Basic x\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n";
        assert_eq!(forwarded_headers(head), "Host: a\r\nAccept: */*\r\n");
    }

    #[test]
    fn error_page_says_nothing_went_direct() {
        let r = String::from_utf8(plain_response(
            502,
            "Bad Gateway",
            Some(&ProxyError::AuthFailed),
        ))
        .unwrap_or_default();
        assert!(r.starts_with("HTTP/1.1 502"));
        assert!(r.contains("X-Pb-Error: PROXY_AUTH_FAILED"));
        assert!(r.contains("Nothing was sent without the proxy"));
    }
}
