//! User-started connectivity check: connect through the proxy to a fixed HTTPS service, verify its certificate, and
//! record how long the answer took and which address the service saw (the proxy's exit address).
//!
//! The service answers with `key=value` lines that include `ip=<address>` (Cloudflare's `/cdn-cgi/trace` format,
//! which the project's own API also serves at `/v1/netcheck`). The check is not a verdict on the address: it only
//! reports what the service observed.

use crate::tls::TlsTrust;
use crate::upstream::{self, find_blank_line};
use crate::{ProxyError, Target, Upstream};
use std::net::IpAddr;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

pub const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckTarget {
    pub host: String,
    pub port: u16,
    pub path: String,
}

impl CheckTarget {
    /// Interim service for the local alpha (ADR-0012): HTTPS, no account, plain-text answer.
    pub fn default_service() -> Self {
        Self {
            host: "www.cloudflare.com".into(),
            port: 443,
            path: "/cdn-cgi/trace".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckOutcome {
    /// From starting the check until the service's answer arrived.
    pub latency_ms: u64,
    pub egress_ip: Option<IpAddr>,
}

pub async fn run(
    up: &Upstream,
    trust: &TlsTrust,
    service: &CheckTarget,
) -> Result<CheckOutcome, ProxyError> {
    timeout(CHECK_TIMEOUT, run_inner(up, trust, service))
        .await
        .map_err(|_| ProxyError::Timeout)?
}

async fn run_inner(
    up: &Upstream,
    trust: &TlsTrust,
    service: &CheckTarget,
) -> Result<CheckOutcome, ProxyError> {
    let start = Instant::now();
    let tunnel = upstream::connect_via(
        up,
        trust,
        &Target {
            host: service.host.clone(),
            port: service.port,
        },
    )
    .await?;
    let mut tls = crate::tls::connect(trust, &service.host, tunnel).await?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: ProjectBrowser-NetCheck/1\r\nAccept: text/plain\r\nConnection: close\r\n\r\n",
        service.path, service.host
    );
    tls.write_all(request.as_bytes())
        .await
        .map_err(|_| ProxyError::CheckFailed)?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut latency = None;
    loop {
        let n = match tls.read(&mut chunk).await {
            Ok(n) => n,
            // Some servers close without a TLS close_notify; what was received still counts.
            Err(_) if !buf.is_empty() => 0,
            Err(_) => return Err(ProxyError::CheckFailed),
        };
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if latency.is_none() && find_blank_line(&buf).is_some() {
            latency = Some(start.elapsed());
        }
        if buf.len() > MAX_RESPONSE {
            break;
        }
    }
    let end = find_blank_line(&buf).ok_or(ProxyError::CheckFailed)?;
    let (status, _) =
        upstream::parse_response_head(&buf[..end]).map_err(|_| ProxyError::CheckFailed)?;
    if status != 200 {
        return Err(ProxyError::CheckFailed);
    }
    let body = String::from_utf8_lossy(&buf[end..]);
    Ok(CheckOutcome {
        latency_ms: u64::try_from(latency.unwrap_or_else(|| start.elapsed()).as_millis())
            .unwrap_or(u64::MAX),
        egress_ip: parse_ip(&body),
    })
}

/// `ip=` line of a trace answer (chunked bodies are tolerated: other lines are ignored).
pub fn parse_ip(body: &str) -> Option<IpAddr> {
    body.lines()
        .find_map(|l| l.trim().strip_prefix("ip="))
        .and_then(|v| v.trim().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_answers() {
        let body = "fl=1\nh=www.cloudflare.com\nip=198.51.100.7\nts=1760000000.1\n";
        assert_eq!(parse_ip(body), "198.51.100.7".parse().ok());
        assert_eq!(parse_ip("ip=2001:db8::5\n"), "2001:db8::5".parse().ok());
        assert_eq!(parse_ip("ip=<script>\n"), None);
        assert_eq!(parse_ip("no ip here"), None);
    }
}
