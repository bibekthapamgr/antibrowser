//! User-started connectivity check: connect through the proxy to a fixed HTTPS service, verify its certificate, and
//! record how long the answer took and which address the service saw (the proxy's exit address).
//!
//! The service answers with `key=value` lines that include `ip=<address>` (Cloudflare's `/cdn-cgi/trace` format,
//! which the project's own API also serves at `/v1/netcheck`). The project's API adds an estimated location of that
//! address (`loc=`, `city=`, `tz=`, `lat=`, `lon=`, `lang=`; ADR-0027); Cloudflare gives `loc=` only. Every value is
//! parsed strictly here, because some of them become browser settings. The check is not a verdict on the address:
//! it only reports what the service observed.

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

#[derive(Clone, Debug, PartialEq)]
pub struct CheckOutcome {
    /// From starting the check until the service's answer arrived.
    pub latency_ms: u64,
    pub egress_ip: Option<IpAddr>,
    /// The service's estimate of where the exit address is (`None`: it gave no location).
    pub geo: Option<TraceGeo>,
}

/// Location facts from a trace answer, each one already validated (an invalid value is dropped, never repaired).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TraceGeo {
    /// ISO 3166-1 alpha-2, upper case (`loc=`).
    pub country: Option<String>,
    /// At most 64 characters: letters, digits, spaces and `.'()-` (`city=`).
    pub city: Option<String>,
    /// A plausible IANA time zone name (`tz=`).
    pub timezone: Option<String>,
    /// BCP 47 `ll-CC` / `lll-CC` (`lang=`).
    pub language: Option<String>,
    /// Both or neither (`lat=`, `lon=`).
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

impl TraceGeo {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

pub async fn run(
    up: &Upstream,
    trust: &TlsTrust,
    service: &CheckTarget,
) -> Result<CheckOutcome, ProxyError> {
    run_within(up, trust, service, CHECK_TIMEOUT).await
}

/// A check that gives up after `limit` (the check before a launch waits at most 10 s).
pub async fn run_within(
    up: &Upstream,
    trust: &TlsTrust,
    service: &CheckTarget,
    limit: Duration,
) -> Result<CheckOutcome, ProxyError> {
    timeout(limit.min(CHECK_TIMEOUT), run_inner(up, trust, service))
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
        geo: Some(parse_geo(&body)).filter(|g| !g.is_empty()),
    })
}

/// `ip=` line of a trace answer (chunked bodies are tolerated: other lines are ignored).
pub fn parse_ip(body: &str) -> Option<IpAddr> {
    body.lines()
        .find_map(|l| l.trim().strip_prefix("ip="))
        .and_then(|v| v.trim().parse().ok())
}

/// The first value of `key` in a trace answer.
fn field<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    body.lines().find_map(|l| {
        l.trim_end_matches('\r')
            .strip_prefix(key)
            .and_then(|r| r.strip_prefix('='))
    })
}

/// `US`, `DE`: two ASCII capitals (`XX`, `ZZ` and Cloudflare's `T1` mean "unknown").
pub fn valid_country(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase()) && s != "XX" && s != "ZZ"
}

/// `UTC` or `Area/Location[/Sub]`: an ASCII capital, then letters; parts of letters, digits and `_+-`.
pub fn valid_time_zone(s: &str) -> bool {
    if s == "UTC" {
        return true;
    }
    let parts: Vec<&str> = s.split('/').collect();
    let area = parts.first().copied().unwrap_or_default();
    (2..=3).contains(&parts.len())
        && s.len() <= 64
        && (2..=20).contains(&area.len())
        && area.as_bytes()[0].is_ascii_uppercase()
        && area.bytes().all(|b| b.is_ascii_alphabetic())
        && parts[1..].iter().all(|p| {
            (1..=30).contains(&p.len())
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
        })
}

/// `en-US`, `fil-PH`: a 2-3 letter lower-case language and a 2-letter upper-case region.
pub fn valid_language(s: &str) -> bool {
    let Some((lang, region)) = s.split_once('-') else {
        return false;
    };
    (2..=3).contains(&lang.len())
        && lang.bytes().all(|b| b.is_ascii_lowercase())
        && region.len() == 2
        && region.bytes().all(|b| b.is_ascii_uppercase())
}

/// A short place name: letters (any script), digits, spaces and `.'()-`; at most 64 characters.
pub fn valid_city(s: &str) -> bool {
    let n = s.chars().count();
    (1..=64).contains(&n)
        && s.trim() == s
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '\'' | '(' | ')' | '-'))
}

fn coordinate(s: Option<&str>, limit: f64) -> Option<f64> {
    let s = s?.trim();
    if s.is_empty()
        || s.len() > 12
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return None;
    }
    s.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && v.abs() <= limit)
}

/// The location lines of a trace answer; values that do not meet the rules above are dropped.
pub fn parse_geo(body: &str) -> TraceGeo {
    let text = |key: &str, ok: fn(&str) -> bool| {
        field(body, key)
            .map(str::trim)
            .filter(|v| ok(v))
            .map(str::to_owned)
    };
    let (latitude, longitude) = match (
        coordinate(field(body, "lat"), 90.0),
        coordinate(field(body, "lon"), 180.0),
    ) {
        (Some(a), Some(b)) => (Some(a), Some(b)),
        _ => (None, None),
    };
    TraceGeo {
        country: text("loc", valid_country),
        city: text("city", valid_city),
        timezone: text("tz", valid_time_zone),
        language: text("lang", valid_language),
        latitude,
        longitude,
    }
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

    #[test]
    fn location_lines_are_parsed_strictly() {
        let body = "ip=198.51.100.7\nloc=US\ncity=New York\ntz=America/New_York\nlat=40.71\nlon=-74.01\nlang=en-US\n";
        assert_eq!(
            parse_geo(body),
            TraceGeo {
                country: Some("US".into()),
                city: Some("New York".into()),
                timezone: Some("America/New_York".into()),
                language: Some("en-US".into()),
                latitude: Some(40.71),
                longitude: Some(-74.01),
            }
        );
        // Cloudflare: the country only (and T1 for Tor, which is not a country).
        let cf = "fl=1\nip=1.2.3.4\nloc=DE\ntls=TLSv1.3\n";
        assert_eq!(parse_geo(cf).country.as_deref(), Some("DE"));
        assert!(parse_geo("loc=T1\n").is_empty());
        assert!(parse_geo("ip=1.2.3.4\n").is_empty());
        // Anything that could smuggle a switch, a path or a second value is dropped.
        let hostile =
            "loc=us\ncity=<b>x</b>\ntz=../../etc/passwd\nlang=en-US --no-sandbox\nlat=91\nlon=10\n";
        assert!(parse_geo(hostile).is_empty(), "{:?}", parse_geo(hostile));
        let one_coordinate = "lat=10\nlon=abc\n";
        assert_eq!(parse_geo(one_coordinate).latitude, None);
        // The first value counts; Windows line ends are tolerated.
        assert_eq!(
            parse_geo("tz=Europe/Berlin\r\ntz=Asia/Tokyo\n")
                .timezone
                .as_deref(),
            Some("Europe/Berlin")
        );
        for tz in [
            "UTC",
            "Etc/GMT+5",
            "America/Argentina/Buenos_Aires",
            "Asia/Kathmandu",
        ] {
            assert!(valid_time_zone(tz), "{tz}");
        }
        for tz in [
            "",
            "utc",
            "Europe",
            "Europe/",
            "A/B",
            "Europe/Ber lin",
            "Europe/../x",
            "America/A/B/C",
        ] {
            assert!(!valid_time_zone(tz), "{tz}");
        }
        for l in ["en-US", "fil-PH", "ne-NP"] {
            assert!(valid_language(l), "{l}");
        }
        for l in ["en", "EN-us", "en-USA", "e-US", "en_US", "en-US,en"] {
            assert!(!valid_language(l), "{l}");
        }
        assert!(valid_city("São Paulo"));
        assert!(!valid_city(&"x".repeat(65)));
        assert!(!valid_city(" Paris"));
    }
}
