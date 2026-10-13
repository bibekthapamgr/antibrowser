//! Transport for the identity provider and the API.
//!
//! - HTTPS with the operating system's certificate verification. Plain `http://` only when explicitly allowed and only
//!   to a loopback address (a developer's local server).
//! - Redirects are never followed: an `Authorization` header must not travel to another origin.
//! - Response bodies are bounded; connection failures are reported as [`HttpError::Offline`] so callers can fall back
//!   to cached data.

use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};
use url::Url;

/// Largest response body accepted (an organization export of 10,000 profiles fits).
pub const MAX_BODY: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

impl Method {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PATCH" => Some(Self::Patch),
            "DELETE" => Some(Self::Delete),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    /// The server could not be reached (no network, DNS failure, refused, timed out).
    #[error("the server could not be reached")]
    Offline,
    /// The address is not https (or loopback http when allowed).
    #[error("the address must use https")]
    Insecure,
    #[error("the address is not valid")]
    BadUrl,
    #[error("the server's certificate could not be verified")]
    Tls,
    #[error("the response was too large")]
    TooLarge,
    #[error("the request failed")]
    Other,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn json(&self) -> Option<serde_json::Value> {
        if self.body.is_empty() {
            return Some(serde_json::Value::Null);
        }
        serde_json::from_slice(&self.body).ok()
    }
}

pub struct Http {
    agent: ureq::Agent,
    allow_loopback_http: bool,
}

pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

impl Http {
    pub fn new(allow_loopback_http: bool) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(60)))
            .user_agent(concat!(
                "project-browser-manager/",
                env!("CARGO_PKG_VERSION")
            ))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .into();
        Self {
            agent,
            allow_loopback_http,
        }
    }

    pub fn allows_loopback_http(&self) -> bool {
        self.allow_loopback_http
    }

    /// Accepts `https://` anywhere, and `http://` only to a loopback address when allowed. No credentials in URLs.
    pub fn check(&self, url: &Url) -> Result<(), HttpError> {
        if !url.username().is_empty() || url.password().is_some() {
            return Err(HttpError::BadUrl);
        }
        match url.scheme() {
            "https" if url.host().is_some() => Ok(()),
            "http" if self.allow_loopback_http && is_loopback(url) => Ok(()),
            "http" | "https" => Err(HttpError::Insecure),
            _ => Err(HttpError::BadUrl),
        }
    }

    pub fn request(
        &self,
        method: Method,
        url: &Url,
        bearer: Option<&str>,
        headers: &[(&str, &str)],
        json_body: Option<&serde_json::Value>,
    ) -> Result<Response, HttpError> {
        self.check(url)?;
        let auth = bearer.map(|t| format!("Bearer {t}"));
        let result = match method {
            Method::Get | Method::Delete => {
                let mut req = if method == Method::Get {
                    self.agent.get(url.as_str())
                } else {
                    self.agent.delete(url.as_str())
                };
                req = req.header("accept", "application/json");
                if let Some(a) = &auth {
                    req = req.header("authorization", a);
                }
                for (k, v) in headers {
                    req = req.header(*k, *v);
                }
                req.call()
            }
            Method::Post | Method::Patch => {
                let mut req = if method == Method::Post {
                    self.agent.post(url.as_str())
                } else {
                    self.agent.patch(url.as_str())
                };
                req = req.header("accept", "application/json");
                if let Some(a) = &auth {
                    req = req.header("authorization", a);
                }
                for (k, v) in headers {
                    req = req.header(*k, *v);
                }
                match json_body {
                    Some(body) => {
                        let bytes = serde_json::to_vec(body).map_err(|_| HttpError::Other)?;
                        req.content_type("application/json").send(&bytes[..])
                    }
                    None => req.send_empty(),
                }
            }
        };
        read(result)
    }

    /// `application/x-www-form-urlencoded` POST (the OAuth token endpoint).
    pub fn post_form(&self, url: &Url, fields: &[(&str, &str)]) -> Result<Response, HttpError> {
        self.check(url)?;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish();
        let result = self
            .agent
            .post(url.as_str())
            .header("accept", "application/json")
            .content_type("application/x-www-form-urlencoded")
            .send(body.as_bytes());
        read(result)
    }
}

fn read(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<Response, HttpError> {
    let response = result.map_err(classify)?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .into_with_config()
        .limit(MAX_BODY)
        .read_to_vec()
        .map_err(classify)?;
    Ok(Response { status, body })
}

fn classify(e: ureq::Error) -> HttpError {
    match e {
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed => HttpError::Offline,
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => HttpError::Tls,
        ureq::Error::BodyExceedsLimit(_) => HttpError::TooLarge,
        ureq::Error::BadUri(_) => HttpError::BadUrl,
        _ => HttpError::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn only_https_or_loopback_http_when_allowed() {
        let strict = Http::new(false);
        let dev = Http::new(true);
        assert_eq!(strict.check(&url("https://api.example.test/v1")), Ok(()));
        assert_eq!(
            strict.check(&url("http://127.0.0.1:8080/v1")),
            Err(HttpError::Insecure)
        );
        assert_eq!(dev.check(&url("http://127.0.0.1:8080/v1")), Ok(()));
        assert_eq!(dev.check(&url("http://[::1]:8080/v1")), Ok(()));
        assert_eq!(dev.check(&url("http://localhost:8080/v1")), Ok(()));
        assert_eq!(
            dev.check(&url("http://api.example.test/v1")),
            Err(HttpError::Insecure)
        );
        assert_eq!(
            dev.check(&url("http://10.0.0.5/v1")),
            Err(HttpError::Insecure)
        );
        assert_eq!(
            strict.check(&url("https://user:pw@api.example.test/")),
            Err(HttpError::BadUrl)
        );
        assert_eq!(
            strict.check(&url("file:///etc/passwd")),
            Err(HttpError::BadUrl)
        );
    }

    #[test]
    fn unreachable_servers_are_offline() {
        // Port 9 on loopback: nothing listens there in CI.
        let dev = Http::new(true);
        let r = dev.request(
            Method::Get,
            &url("http://127.0.0.1:9/v1/me"),
            None,
            &[],
            None,
        );
        assert_eq!(r.err(), Some(HttpError::Offline));
    }
}
