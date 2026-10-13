//! Per-profile proxy routing (milestone 05).
//!
//! Chromium accepts a proxy address on its command line but not a password, and it cannot log in to SOCKS5 proxies
//! at all. So the browser is pointed at a **loopback gateway** owned by the manager ([`gateway`]); the gateway relays
//! every connection through the profile's upstream proxy ([`upstream`]) and adds the login itself. The browser never
//! sees credentials, nothing secret is on a command line, and credentials are sent only to the configured proxy
//! endpoint — never in answer to a challenge from anywhere else.
//!
//! Routing is fail-closed by default: the browser knows only the gateway's address, and the gateway has no direct
//! route, so a failing proxy blocks traffic instead of sending it without the proxy. A profile can opt out
//! ([`gateway::Fallback::Direct`]); then only an unreachable proxy falls back, and every direct connection is
//! counted so the manager can show it. Destination names are passed to the proxy
//! (HTTP `CONNECT host:port`, SOCKS5 domain addresses), so the device never resolves the sites a profile visits;
//! only the proxy's own name is resolved locally.
//!
//! Supported (see docs/network/protocol-support.md): HTTP and HTTPS proxies with no login or Basic login; SOCKS5
//! with no login or username/password (RFC 1929). Everything else fails visibly with a specific error code.

pub mod check;
pub mod gateway;
pub mod tls;
pub mod upstream;

#[cfg(feature = "testing")]
pub mod testing;

use serde::{Deserialize, Serialize};
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

/// Connecting to the proxy (per address tried).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Proxy handshake (TLS, login, tunnel request) once connected.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest username or password: SOCKS5 carries each in one length byte.
pub const MAX_CREDENTIAL_BYTES: usize = 255;
pub const MAX_HOST_BYTES: usize = 253;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProxyKind {
    /// Plain HTTP proxy (`CONNECT` for https/wss, absolute-form requests for http).
    Http,
    /// HTTP proxy reached over TLS (the proxy's certificate is verified like a website's).
    Https,
    /// SOCKS5; destination names are resolved by the proxy.
    Socks5,
}

impl ProxyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
            Self::Socks5 => "socks5",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "http" => Self::Http,
            "https" => Self::Https,
            "socks5" | "socks5h" => Self::Socks5,
            _ => return None,
        })
    }
    pub fn default_port(self) -> u16 {
        match self {
            Self::Http => 8080,
            Self::Https => 443,
            Self::Socks5 => 1080,
        }
    }
}

/// A proxy login. `Debug` never prints the values.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials(<redacted>)")
    }
}

/// Where the proxy may be: public addresses always; this computer and the local network only when the user's local
/// policy allows it. Link-local (incl. cloud metadata 169.254.169.254), unspecified, multicast and broadcast
/// addresses are never used.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AddressPolicy {
    pub allow_private: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Upstream {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub credentials: Option<Credentials>,
    pub policy: AddressPolicy,
}

impl fmt::Debug for Upstream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Upstream({} {}:{}, login: {})",
            self.kind.as_str(),
            self.host,
            self.port,
            self.credentials.is_some()
        )
    }
}

/// Why a proxy could not be used. Every variant has a stable code for the UI and the network-check log.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProxyError {
    #[error("the proxy's address could not be found")]
    DnsFailed,
    #[error("the proxy could not be reached")]
    Unreachable,
    #[error(
        "the proxy is on this computer or the local network, which is not allowed by your settings"
    )]
    PrivateAddress,
    #[error("the proxy is at an address that is never used (link-local, multicast or unspecified)")]
    ForbiddenAddress,
    #[error("the secure connection to the proxy failed")]
    TlsFailed,
    #[error("the proxy needs a login and none is saved")]
    AuthRequired,
    #[error("the proxy rejected the login")]
    AuthFailed,
    #[error("the proxy only offers a login method this app does not support ({0})")]
    AuthUnsupported(String),
    #[error("the proxy answered in an unexpected way ({0})")]
    Protocol(String),
    #[error("the proxy could not reach the website")]
    TargetFailed,
    #[error("the proxy refused to connect to this website")]
    TargetBlocked,
    #[error("the proxy did not answer in time")]
    Timeout,
    #[error("the check service answered in an unexpected way")]
    CheckFailed,
}

impl ProxyError {
    /// The proxy itself could not be reached, as opposed to a login, TLS, address-policy or website problem. Only
    /// these errors may fall back to a direct connection when the user turned fail-closed routing off.
    pub fn proxy_unreachable(&self) -> bool {
        matches!(self, Self::DnsFailed | Self::Unreachable | Self::Timeout)
    }

    /// The proxy answered but could not or would not reach the website: the proxy itself works.
    pub fn is_website_error(&self) -> bool {
        matches!(self, Self::TargetFailed | Self::TargetBlocked)
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::DnsFailed => "PROXY_DNS_FAILED",
            Self::Unreachable => "PROXY_UNREACHABLE",
            Self::PrivateAddress => "PROXY_PRIVATE_ADDRESS",
            Self::ForbiddenAddress => "PROXY_FORBIDDEN_ADDRESS",
            Self::TlsFailed => "PROXY_TLS_FAILED",
            Self::AuthRequired => "PROXY_AUTH_REQUIRED",
            Self::AuthFailed => "PROXY_AUTH_FAILED",
            Self::AuthUnsupported(_) => "PROXY_AUTH_UNSUPPORTED",
            Self::Protocol(_) => "PROXY_PROTOCOL_ERROR",
            Self::TargetFailed => "PROXY_TARGET_FAILED",
            Self::TargetBlocked => "PROXY_TARGET_BLOCKED",
            Self::Timeout => "PROXY_TIMEOUT",
            Self::CheckFailed => "CHECK_FAILED",
        }
    }
}

/// Validation of a proxy's settings before it is saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("enter the proxy's host name or IP address only (no scheme, path or login)")]
    BadHost,
    #[error("the port must be between 1 and 65535")]
    BadPort,
    #[error("usernames and passwords can be at most 255 bytes, without control characters")]
    BadCredentials,
    #[error("HTTP proxy usernames cannot contain a colon (:)")]
    ColonInUsername,
    #[error(
        "the proxy is on this computer or the local network, which is not allowed by your settings"
    )]
    PrivateAddress,
    #[error("the proxy is at an address that is never used (link-local, multicast or unspecified)")]
    ForbiddenAddress,
}

impl ConfigError {
    pub fn code(self) -> &'static str {
        match self {
            Self::BadHost => "PROXY_BAD_HOST",
            Self::BadPort => "PROXY_BAD_PORT",
            Self::BadCredentials => "PROXY_BAD_CREDENTIALS",
            Self::ColonInUsername => "PROXY_BAD_CREDENTIALS",
            Self::PrivateAddress => "PROXY_PRIVATE_ADDRESS",
            Self::ForbiddenAddress => "PROXY_FORBIDDEN_ADDRESS",
        }
    }
}

/// How an address may be used as a proxy endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressClass {
    Public,
    /// Loopback, RFC 1918, carrier-grade NAT, IPv6 unique-local.
    Private,
    /// Link-local (incl. metadata services), unspecified, multicast, broadcast, documentation-only.
    Forbidden,
}

pub fn classify(ip: IpAddr) -> AddressClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return classify_v4(v4);
            }
            let seg0 = v6.segments()[0];
            if v6.is_unspecified() || v6.is_multicast() || (seg0 & 0xffc0) == 0xfe80 {
                AddressClass::Forbidden
            } else if v6.is_loopback() || (seg0 & 0xfe00) == 0xfc00 {
                AddressClass::Private
            } else {
                AddressClass::Public
            }
        }
    }
}

fn classify_v4(v4: Ipv4Addr) -> AddressClass {
    let [a, b, ..] = v4.octets();
    if v4.is_unspecified()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_broadcast()
        || v4.is_documentation()
        || a == 0
    {
        AddressClass::Forbidden
    } else if v4.is_loopback() || v4.is_private() || (a == 100 && (64..128).contains(&b)) {
        AddressClass::Private
    } else {
        AddressClass::Public
    }
}

/// Applies the address policy to one address (used for literal hosts and for every resolved address).
pub fn address_allowed(ip: IpAddr, policy: AddressPolicy) -> Result<(), ProxyError> {
    match classify(ip) {
        AddressClass::Public => Ok(()),
        AddressClass::Private if policy.allow_private => Ok(()),
        AddressClass::Private => Err(ProxyError::PrivateAddress),
        AddressClass::Forbidden => Err(ProxyError::ForbiddenAddress),
    }
}

/// A host as typed by the user: a DNS name or an IP literal (IPv6 with or without brackets). Returns the
/// normalised form (lower-case name, bare IPv6) or an error. Schemes, paths, ports, logins and spaces are refused.
pub fn normalize_host(input: &str) -> Result<String, ConfigError> {
    let h = input.trim();
    let bare = h
        .strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(h);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let name = h.trim_end_matches('.').to_ascii_lowercase();
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if name.is_empty() || name.len() > MAX_HOST_BYTES || !name.split('.').all(label_ok) {
        return Err(ConfigError::BadHost);
    }
    // A purely numeric dotted name that is not a valid IPv4 address (e.g. 999.1.1.1) is a mistake, not a name.
    if name
        .split('.')
        .all(|l| l.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(ConfigError::BadHost);
    }
    Ok(name)
}

/// Checks a proxy before it is saved. Names are checked against the policy when they resolve, at connect time.
pub fn validate(
    kind: ProxyKind,
    host: &str,
    port: u32,
    credentials: Option<&Credentials>,
    policy: AddressPolicy,
) -> Result<(String, u16), ConfigError> {
    let host = normalize_host(host)?;
    let port = u16::try_from(port)
        .ok()
        .filter(|p| *p > 0)
        .ok_or(ConfigError::BadPort)?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        address_allowed(ip, policy).map_err(|e| match e {
            ProxyError::PrivateAddress => ConfigError::PrivateAddress,
            _ => ConfigError::ForbiddenAddress,
        })?;
    }
    if let Some(c) = credentials {
        let ok = |s: &str| {
            !s.is_empty() && s.len() <= MAX_CREDENTIAL_BYTES && !s.chars().any(char::is_control)
        };
        if !ok(&c.username) || !ok(&c.password) {
            return Err(ConfigError::BadCredentials);
        }
        if kind != ProxyKind::Socks5 && c.username.contains(':') {
            return Err(ConfigError::ColonInUsername);
        }
    }
    Ok((host, port))
}

/// A destination as written in `CONNECT` and absolute-form requests: `host:port` or `[v6]:port`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

impl Target {
    pub fn parse_authority(s: &str) -> Option<Self> {
        let (host, port) = if let Some(rest) = s.strip_prefix('[') {
            let (h, p) = rest.split_once("]:")?;
            h.parse::<Ipv6Addr>().ok()?;
            (h.to_owned(), p)
        } else {
            let (h, p) = s.rsplit_once(':')?;
            (h.to_owned(), p)
        };
        let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
        let host = if host.parse::<IpAddr>().is_ok() {
            host
        } else {
            normalize_host(&host).ok()?
        };
        Some(Self { host, port })
    }

    /// `host:port`, bracketing IPv6.
    pub fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Shared tokio runtime for gateways and checks (two worker threads; the manager's own code stays synchronous).
pub struct NetRuntime {
    rt: tokio::runtime::Runtime,
}

impl NetRuntime {
    pub fn new() -> std::io::Result<Arc<Self>> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("pb-net")
            .enable_all()
            .build()?;
        Ok(Arc::new(Self { rt }))
    }

    pub fn handle(&self) -> tokio::runtime::Handle {
        self.rt.handle().clone()
    }

    /// Runs a future to completion from synchronous code (never call from inside the runtime).
    pub fn block_on<F: std::future::Future>(&self, f: F) -> F::Output {
        self.rt.block_on(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_names_or_ip_literals_only() {
        assert_eq!(
            normalize_host("Proxy.Example.COM.").as_deref(),
            Ok("proxy.example.com")
        );
        assert_eq!(
            normalize_host("[2001:db8::1]").as_deref(),
            Ok("2001:db8::1")
        );
        assert_eq!(normalize_host("203.0.113.9").as_deref(), Ok("203.0.113.9"));
        for bad in [
            "",
            "http://proxy.example",
            "user:pass@proxy.example",
            "proxy.example:8080",
            "proxy.example/path",
            "pro xy.example",
            "-bad.example",
            "999.1.1.1",
            "a..b",
        ] {
            assert_eq!(normalize_host(bad), Err(ConfigError::BadHost), "{bad}");
        }
    }

    #[test]
    fn address_policy() {
        let strict = AddressPolicy::default();
        let local = AddressPolicy {
            allow_private: true,
        };
        for (ip, class) in [
            ("8.8.8.8", AddressClass::Public),
            ("2606:4700::1111", AddressClass::Public),
            ("127.0.0.1", AddressClass::Private),
            ("192.168.1.10", AddressClass::Private),
            ("10.1.2.3", AddressClass::Private),
            ("100.64.0.1", AddressClass::Private),
            ("::1", AddressClass::Private),
            ("fd00::1", AddressClass::Private),
            ("::ffff:192.168.0.1", AddressClass::Private),
            ("169.254.169.254", AddressClass::Forbidden),
            ("fe80::1", AddressClass::Forbidden),
            ("0.0.0.0", AddressClass::Forbidden),
            ("::", AddressClass::Forbidden),
            ("224.0.0.1", AddressClass::Forbidden),
            ("255.255.255.255", AddressClass::Forbidden),
        ] {
            let ip: IpAddr = ip.parse().unwrap_or_else(|e| panic!("{ip}: {e}"));
            assert_eq!(classify(ip), class, "{ip}");
        }
        let lo: IpAddr = "127.0.0.1".parse().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(address_allowed(lo, strict), Err(ProxyError::PrivateAddress));
        assert_eq!(address_allowed(lo, local), Ok(()));
        let meta: IpAddr = "169.254.169.254".parse().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            address_allowed(meta, local),
            Err(ProxyError::ForbiddenAddress)
        );
    }

    #[test]
    fn validation_before_saving() {
        let creds = |u: &str, p: &str| Credentials {
            username: u.into(),
            password: p.into(),
        };
        let strict = AddressPolicy::default();
        assert_eq!(
            validate(ProxyKind::Http, "proxy.example", 3128, None, strict),
            Ok(("proxy.example".into(), 3128))
        );
        assert_eq!(
            validate(ProxyKind::Http, "proxy.example", 0, None, strict),
            Err(ConfigError::BadPort)
        );
        assert_eq!(
            validate(ProxyKind::Http, "proxy.example", 70000, None, strict),
            Err(ConfigError::BadPort)
        );
        assert_eq!(
            validate(ProxyKind::Socks5, "127.0.0.1", 1080, None, strict),
            Err(ConfigError::PrivateAddress)
        );
        assert_eq!(
            validate(
                ProxyKind::Http,
                "proxy.example",
                80,
                Some(&creds("a:b", "x")),
                strict
            ),
            Err(ConfigError::ColonInUsername)
        );
        assert!(
            validate(
                ProxyKind::Socks5,
                "proxy.example",
                80,
                Some(&creds("a:b", "x")),
                strict
            )
            .is_ok(),
            "SOCKS5 usernames may contain colons"
        );
        let long = "x".repeat(256);
        assert_eq!(
            validate(
                ProxyKind::Socks5,
                "proxy.example",
                80,
                Some(&creds(&long, "x")),
                strict
            ),
            Err(ConfigError::BadCredentials)
        );
        assert_eq!(
            validate(
                ProxyKind::Http,
                "proxy.example",
                80,
                Some(&creds("u", "a\nb")),
                strict
            ),
            Err(ConfigError::BadCredentials)
        );
    }

    #[test]
    fn credentials_never_print() {
        let c = Credentials {
            username: "alice".into(),
            password: "hunter2".into(),
        };
        let up = Upstream {
            kind: ProxyKind::Http,
            host: "p.example".into(),
            port: 1,
            credentials: Some(c.clone()),
            policy: AddressPolicy::default(),
        };
        for s in [format!("{c:?}"), format!("{up:?}")] {
            assert!(!s.contains("alice") && !s.contains("hunter2"), "{s}");
        }
    }

    #[test]
    fn authorities() {
        assert_eq!(
            Target::parse_authority("Example.com:443"),
            Some(Target {
                host: "example.com".into(),
                port: 443
            })
        );
        let v6 = Target::parse_authority("[2001:db8::1]:8443");
        assert_eq!(
            v6.as_ref().map(Target::authority).as_deref(),
            Some("[2001:db8::1]:8443")
        );
        for bad in [
            "example.com",
            "example.com:0",
            "example.com:x",
            "[::1:443",
            "a b:1",
            ":443",
        ] {
            assert_eq!(Target::parse_authority(bad), None, "{bad}");
        }
    }
}
