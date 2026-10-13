//! In-process test servers (feature `testing`): HTTP, HTTPS and SOCKS5 proxies with optional logins, a plain HTTP
//! origin, a TLS "check" service, and a throwaway certificate authority. Destination names are resolved only through
//! the `hosts` map given to a proxy, so tests never touch real DNS and can tell names from addresses.
//!
//! Not for production use: these servers accept anything a test asks them to.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::tls::TlsTrust;
use crate::upstream::{find_blank_line, read_head};
use crate::{AddressPolicy, Credentials, ProxyKind, Upstream};
use base64::Engine;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use tokio::runtime::Runtime;
use tokio::task::AbortHandle;

fn runtime() -> Arc<Runtime> {
    Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test runtime"),
    )
}

// ---------------------------------------------------------------------------------------------- certificates
/// A test CA and one server certificate for the given names plus 127.0.0.1 and ::1.
pub struct TestCa {
    pub ca: CertificateDer<'static>,
    leaf: CertificateDer<'static>,
    leaf_key: Vec<u8>,
}

impl TestCa {
    pub fn new(names: &[&str]) -> Arc<Self> {
        use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, SanType};
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("params");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params
            .distinguished_name
            .push(DnType::CommonName, "Project Browser test CA");
        let ca_key = KeyPair::generate().expect("key");
        let ca_cert = ca_params.self_signed(&ca_key).expect("ca");
        let issuer = Issuer::new(ca_params, ca_key);
        let mut leaf_params =
            CertificateParams::new(names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>())
                .expect("params");
        leaf_params
            .subject_alt_names
            .push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        leaf_params
            .subject_alt_names
            .push(SanType::IpAddress("::1".parse().expect("ip")));
        let leaf_key = KeyPair::generate().expect("key");
        let leaf = leaf_params.signed_by(&leaf_key, &issuer).expect("leaf");
        Arc::new(Self {
            ca: ca_cert.der().clone(),
            leaf: leaf.der().clone(),
            leaf_key: leaf_key.serialize_der(),
        })
    }

    pub fn trust(&self) -> TlsTrust {
        TlsTrust::Roots(vec![self.ca.clone()])
    }

    fn acceptor(&self) -> tokio_rustls::TlsAcceptor {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("versions")
            .with_no_client_auth()
            .with_single_cert(
                vec![self.leaf.clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.leaf_key.clone())),
            )
            .expect("cert");
        tokio_rustls::TlsAcceptor::from(Arc::new(config))
    }
}

// ---------------------------------------------------------------------------------------------- proxies
#[derive(Clone, Default)]
pub struct ProxyOptions {
    /// Required login, if any.
    pub login: Option<(String, String)>,
    /// HTTP only: challenge with Digest instead of Basic (unsupported by the gateway).
    pub digest_only: bool,
    /// Destination names this proxy can reach (anything else fails as "host unreachable").
    pub hosts: HashMap<String, SocketAddr>,
    /// HTTPS proxies: the certificate authority whose leaf the proxy presents.
    pub tls: Option<Arc<TestCa>>,
    /// Address to listen on (default 127.0.0.1).
    pub bind: Option<IpAddr>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyLogEntry {
    /// `CONNECT host:port`, `GET http://…`, or `SOCKS5 domain host:port` / `SOCKS5 ip …`.
    pub request: String,
    /// The `Proxy-Authorization` header or SOCKS5 login as received (`user:password`), if any.
    pub login: Option<String>,
    pub accepted: bool,
}

pub struct TestProxy {
    pub kind: ProxyKind,
    port: u16,
    rt: Arc<Runtime>,
    tasks: Arc<Mutex<Vec<AbortHandle>>>,
    log: Arc<Mutex<Vec<ProxyLogEntry>>>,
    opts: ProxyOptions,
}

impl TestProxy {
    pub fn http(opts: ProxyOptions) -> Self {
        Self::start(ProxyKind::Http, opts)
    }
    pub fn https(opts: ProxyOptions) -> Self {
        assert!(opts.tls.is_some(), "HTTPS test proxy needs a TestCa");
        Self::start(ProxyKind::Https, opts)
    }
    pub fn socks5(opts: ProxyOptions) -> Self {
        Self::start(ProxyKind::Socks5, opts)
    }

    fn start(kind: ProxyKind, opts: ProxyOptions) -> Self {
        let rt = runtime();
        let ip = opts.bind.unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let listener = rt.block_on(TcpListener::bind((ip, 0))).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let p = Self {
            kind,
            port,
            rt,
            tasks: Arc::default(),
            log: Arc::default(),
            opts,
        };
        p.serve(listener);
        p
    }

    fn serve(&self, listener: TcpListener) {
        let (kind, opts, log, tasks) = (
            self.kind,
            self.opts.clone(),
            self.log.clone(),
            self.tasks.clone(),
        );
        let inner_tasks = tasks.clone();
        let h = self.rt.spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let (opts, log) = (opts.clone(), log.clone());
                let h = tokio::spawn(async move {
                    match kind {
                        ProxyKind::Http => {
                            let _ = http_proxy(stream, &opts, &log).await;
                        }
                        ProxyKind::Https => {
                            let Some(ca) = &opts.tls else { return };
                            if let Ok(tls) = ca.acceptor().accept(stream).await {
                                let _ = http_proxy(tls, &opts, &log).await;
                            }
                        }
                        ProxyKind::Socks5 => {
                            let _ = socks5_proxy(stream, &opts, &log).await;
                        }
                    }
                });
                inner_tasks.lock().unwrap().push(h.abort_handle());
            }
        });
        tasks.lock().unwrap().push(h.abort_handle());
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn log(&self) -> Vec<ProxyLogEntry> {
        self.log.lock().unwrap().clone()
    }

    /// Simulates an outage: stops listening and cuts every open tunnel.
    pub fn stop(&self) {
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    /// Comes back on the same port (after [`stop`](Self::stop)).
    pub fn restart(&self) {
        let ip = self.opts.bind.unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let listener = self
            .rt
            .block_on(TcpListener::bind((ip, self.port)))
            .expect("rebind");
        self.serve(listener);
    }

    /// An upstream description pointing at this proxy (local addresses allowed).
    pub fn upstream(&self, credentials: Option<Credentials>) -> Upstream {
        Upstream {
            kind: self.kind,
            host: self
                .opts
                .bind
                .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
                .to_string(),
            port: self.port,
            credentials,
            policy: AddressPolicy {
                allow_private: true,
            },
        }
    }
}

impl Drop for TestProxy {
    fn drop(&mut self) {
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
    }
}

fn resolve(opts: &ProxyOptions, host: &str, port: u16) -> Option<SocketAddr> {
    if let Some(a) = opts.hosts.get(host) {
        return Some(SocketAddr::new(
            a.ip(),
            if a.port() == 0 { port } else { a.port() },
        ));
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()
        .map(|ip| SocketAddr::new(ip, port))
}

async fn http_proxy<S: AsyncRead + AsyncWrite + Unpin>(
    mut s: S,
    opts: &ProxyOptions,
    log: &Mutex<Vec<ProxyLogEntry>>,
) -> std::io::Result<()> {
    let Ok((head, rest)) = read_head(&mut s, 64 * 1024).await else {
        return Ok(());
    };
    let text = String::from_utf8_lossy(&head).into_owned();
    let line = text.split("\r\n").next().unwrap_or_default().to_owned();
    let auth = text.split("\r\n").find_map(|l| {
        let (n, v) = l.split_once(':')?;
        n.trim()
            .eq_ignore_ascii_case("proxy-authorization")
            .then(|| v.trim().to_owned())
    });
    let accepted = match &opts.login {
        None => true,
        Some((u, p)) => {
            !opts.digest_only
                && auth.as_deref()
                    == Some(&format!(
                        "Basic {}",
                        base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}"))
                    ))
        }
    };
    let mut parts = line.split(' ');
    let (method, target) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    log.lock().unwrap().push(ProxyLogEntry {
        request: format!("{method} {target}"),
        login: auth.clone(),
        accepted,
    });
    if !accepted {
        let challenge = if opts.digest_only {
            "Digest realm=\"pb\", nonce=\"abc\", qop=\"auth\""
        } else {
            "Basic realm=\"pb\""
        };
        s.write_all(
            format!("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: {challenge}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;
        return Ok(());
    }
    if method == "CONNECT" {
        let Some(t) = crate::Target::parse_authority(target) else {
            return Ok(());
        };
        let Some(addr) = resolve(opts, &t.host, t.port) else {
            s.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .await?;
            return Ok(());
        };
        let Ok(mut up) = TcpStream::connect(addr).await else {
            s.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .await?;
            return Ok(());
        };
        s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .await?;
        if !rest.is_empty() {
            up.write_all(&rest).await?;
        }
        let _ = copy_bidirectional(&mut s, &mut up).await;
        return Ok(());
    }
    // Absolute-form: forward as origin-form to the mapped origin.
    let url = target.strip_prefix("http://").unwrap_or(target);
    let (authority, path) = url.find('/').map_or((url, "/"), |i| (&url[..i], &url[i..]));
    let (host, port) = match crate::Target::parse_authority(authority) {
        Some(t) => (t.host, t.port),
        None => (authority.to_ascii_lowercase(), 80),
    };
    let Some(addr) = resolve(opts, &host, port) else {
        s.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    };
    let Ok(mut up) = TcpStream::connect(addr).await else {
        s.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    };
    let mut out = format!("{method} {path} HTTP/1.1\r\n");
    for l in text.split("\r\n").skip(1).filter(|l| !l.is_empty()) {
        if !l.to_ascii_lowercase().starts_with("proxy-") {
            out.push_str(l);
            out.push_str("\r\n");
        }
    }
    out.push_str("\r\n");
    up.write_all(out.as_bytes()).await?;
    up.write_all(&rest).await?;
    let _ = copy_bidirectional(&mut s, &mut up).await;
    Ok(())
}

async fn socks5_proxy(
    mut s: TcpStream,
    opts: &ProxyOptions,
    log: &Mutex<Vec<ProxyLogEntry>>,
) -> std::io::Result<()> {
    let mut hdr = [0u8; 2];
    s.read_exact(&mut hdr).await?;
    let mut methods = vec![0u8; usize::from(hdr[1])];
    s.read_exact(&mut methods).await?;
    let mut login = None;
    let mut accepted = true;
    match &opts.login {
        None => s.write_all(&[5, 0]).await?,
        Some((u, p)) if methods.contains(&2) => {
            s.write_all(&[5, 2]).await?;
            let mut v = [0u8; 2];
            s.read_exact(&mut v).await?;
            let mut user = vec![0u8; usize::from(v[1])];
            s.read_exact(&mut user).await?;
            let mut pl = [0u8; 1];
            s.read_exact(&mut pl).await?;
            let mut pass = vec![0u8; usize::from(pl[0])];
            s.read_exact(&mut pass).await?;
            let (user, pass) = (
                String::from_utf8_lossy(&user),
                String::from_utf8_lossy(&pass),
            );
            login = Some(format!("{user}:{pass}"));
            accepted = *u == user && *p == pass;
            s.write_all(&[1, u8::from(!accepted)]).await?;
        }
        Some(_) => {
            s.write_all(&[5, 0xFF]).await?;
            accepted = false;
        }
    }
    if !accepted {
        log.lock().unwrap().push(ProxyLogEntry {
            request: "SOCKS5 login".into(),
            login,
            accepted,
        });
        return Ok(());
    }
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    let (kind, host) = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            ("ip", Ipv4Addr::from(a).to_string())
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            ("ip", std::net::Ipv6Addr::from(a).to_string())
        }
        _ => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            let mut n = vec![0u8; usize::from(l[0])];
            s.read_exact(&mut n).await?;
            ("domain", String::from_utf8_lossy(&n).into_owned())
        }
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await?;
    let port = u16::from_be_bytes(p);
    log.lock().unwrap().push(ProxyLogEntry {
        request: format!("SOCKS5 {kind} {host}:{port}"),
        login,
        accepted: true,
    });
    let reply = |code: u8| [5, code, 0, 1, 0, 0, 0, 0, 0, 0];
    let Some(addr) = resolve(opts, &host, port) else {
        s.write_all(&reply(4)).await?;
        return Ok(());
    };
    let Ok(mut up) = TcpStream::connect(addr).await else {
        s.write_all(&reply(5)).await?;
        return Ok(());
    };
    s.write_all(&reply(0)).await?;
    let _ = copy_bidirectional(&mut s, &mut up).await;
    Ok(())
}

// ---------------------------------------------------------------------------------------------- servers
#[derive(Clone, Debug)]
pub struct SeenRequest {
    pub line: String,
    pub headers: Vec<(String, String)>,
    pub peer: SocketAddr,
}

impl SeenRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// A plain HTTP server answering `origin <path>`; every request is recorded.
pub struct TestOrigin {
    pub port: u16,
    ip: IpAddr,
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    _rt: Arc<Runtime>,
}

impl TestOrigin {
    pub fn start() -> Self {
        Self::start_on(IpAddr::V4(Ipv4Addr::LOCALHOST)).expect("bind")
    }

    /// `None` when the address cannot be used on this machine (e.g. no IPv6 loopback).
    pub fn start_on(ip: IpAddr) -> Option<Self> {
        let rt = runtime();
        let listener = rt.block_on(TcpListener::bind((ip, 0))).ok()?;
        let port = listener.local_addr().ok()?.port();
        let seen: Arc<Mutex<Vec<SeenRequest>>> = Arc::default();
        let log = seen.clone();
        rt.spawn(async move {
            loop {
                let Ok((mut s, peer)) = listener.accept().await else {
                    continue;
                };
                let log = log.clone();
                tokio::spawn(async move {
                    let Ok((head, _)) = read_head(&mut s, 64 * 1024).await else {
                        return;
                    };
                    let req = parse_request(&head, peer);
                    let path = req.line.split(' ').nth(1).unwrap_or("/").to_owned();
                    log.lock().unwrap().push(req);
                    let body = format!("origin {path}");
                    let _ = s
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                });
            }
        });
        Some(Self {
            port,
            ip,
            seen,
            _rt: rt,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        SocketAddr::new(self.ip, self.port)
    }

    pub fn seen(&self) -> Vec<SeenRequest> {
        self.seen.lock().unwrap().clone()
    }
}

fn parse_request(head: &[u8], peer: SocketAddr) -> SeenRequest {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or_default().to_owned();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_owned(), v.trim().to_owned()))
        .collect();
    SeenRequest {
        line,
        headers,
        peer,
    }
}

/// A TLS service answering `ip=<peer address>` like `/cdn-cgi/trace`, to test connectivity checks.
pub struct TestCheckService {
    pub port: u16,
    pub ca: Arc<TestCa>,
    requests: Arc<Mutex<u64>>,
    _rt: Arc<Runtime>,
}

impl TestCheckService {
    /// `reported_ip` is what the service claims to see (the tests' "egress address").
    pub fn start(name: &str, reported_ip: &str) -> Self {
        let rt = runtime();
        let ca = TestCa::new(&[name]);
        let listener = rt
            .block_on(TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let acceptor = ca.acceptor();
        let requests: Arc<Mutex<u64>> = Arc::default();
        let count = requests.clone();
        let ip = reported_ip.to_owned();
        rt.spawn(async move {
            loop {
                let Ok((s, _)) = listener.accept().await else {
                    continue;
                };
                let (acceptor, count, ip) = (acceptor.clone(), count.clone(), ip.clone());
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(s).await else {
                        return;
                    };
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while find_blank_line(&buf).is_none() {
                        match tls.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    *count.lock().unwrap() += 1;
                    let body = format!("fl=1\nip={ip}\nts=0\n");
                    let _ = tls
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        Self {
            port,
            ca,
            requests,
            _rt: rt,
        }
    }

    pub fn addr(&self) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, self.port))
    }

    pub fn requests(&self) -> u64 {
        *self.requests.lock().unwrap()
    }
}
