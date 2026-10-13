//! Approved sites (milestone 10): the same grammar and matching as `packages/contracts/src/automation.ts`, checked
//! against the same vectors (`packages/contracts/fixtures/automation-cases.json`).
//!
//! A pattern is `scheme://host[:port]` or `scheme://*.domain[:port]` with a lowercase ASCII host. An address is
//! matched by a deliberately strict grammar: no user names, backslashes, whitespace or control characters, a
//! lowercase ASCII host and an optional port without leading zeros. Anything outside the grammar is refused rather
//! than interpreted, so what is checked is what the browser opens.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub scheme: &'static str,
    pub host: String,
    pub port: u16,
}

impl Origin {
    /// `scheme://host[:port]` with the port left out when it is the scheme's default.
    pub fn display(&self) -> String {
        if self.port == default_port(self.scheme) {
            format!("{}://{}", self.scheme, self.host)
        } else {
            format!("{}://{}:{}", self.scheme, self.host, self.port)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Pattern {
    scheme: &'static str,
    wildcard: bool,
    host: String,
    port: u16,
}

fn default_port(scheme: &str) -> u16 {
    if scheme == "https" { 443 } else { 80 }
}

fn scheme_of(s: &str) -> Option<(&'static str, &str)> {
    if let Some(rest) = s.strip_prefix("https://") {
        Some(("https", rest))
    } else {
        s.strip_prefix("http://").map(|rest| ("http", rest))
    }
}

fn valid_label(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.split('.').all(valid_label)
}

/// `host[:port]` → (host, port); the port has 1-5 digits, no leading zero.
fn host_port(s: &str, scheme: &'static str) -> Option<(String, u16)> {
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => {
            if p.is_empty()
                || p.len() > 5
                || !p.bytes().all(|c| c.is_ascii_digit())
                || p.starts_with('0')
            {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if !(1..=65535).contains(&n) {
                return None;
            }
            (h, n as u16)
        }
        None => (s, default_port(scheme)),
    };
    valid_host(host).then(|| (host.to_owned(), port))
}

fn parse_pattern(p: &str) -> Option<Pattern> {
    if p.len() > 260 {
        return None;
    }
    let (scheme, rest) = scheme_of(p)?;
    let (wildcard, rest) = match rest.strip_prefix("*.") {
        Some(r) => (true, r),
        None => (false, rest),
    };
    let (host, port) = host_port(rest, scheme)?;
    if wildcard && host.split('.').count() < 2 {
        return None;
    }
    Some(Pattern {
        scheme,
        wildcard,
        host,
        port,
    })
}

/// Whether a pattern is well formed.
pub fn valid_pattern(p: &str) -> bool {
    parse_pattern(p).is_some()
}

/// The origin of an address, by the strict grammar (None when the address is outside it).
pub fn address_origin(url: &str) -> Option<Origin> {
    if url.len() > 2048
        || url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return None;
    }
    let (scheme, rest) = scheme_of(url)?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        return None;
    }
    let (host, port) = host_port(authority, scheme)?;
    Some(Origin { scheme, host, port })
}

/// Whether `url` is on one of the approved sites.
pub fn origin_allowed(url: &str, patterns: &[String]) -> bool {
    let Some(o) = address_origin(url) else {
        return false;
    };
    patterns.iter().any(|p| {
        let Some(q) = parse_pattern(p) else {
            return false;
        };
        if q.scheme != o.scheme || q.port != o.port {
            return false;
        }
        if q.wildcard {
            o.host.len() > q.host.len() + 1
                && o.host.ends_with(&q.host)
                && o.host.as_bytes()[o.host.len() - q.host.len() - 1] == b'.'
        } else {
            o.host == q.host
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Cases {
        patterns: PatternCases,
        matches: Vec<MatchCase>,
    }
    #[derive(Deserialize)]
    struct PatternCases {
        valid: Vec<String>,
        invalid: Vec<String>,
    }
    #[derive(Deserialize)]
    struct MatchCase {
        url: String,
        patterns: Vec<String>,
        allowed: bool,
    }

    #[test]
    fn shared_vectors_match_the_api() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/contracts/fixtures/automation-cases.json"
        );
        let cases: Cases = serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_default())
            .unwrap_or_else(|_| Cases {
                patterns: PatternCases {
                    valid: vec![],
                    invalid: vec![],
                },
                matches: vec![],
            });
        assert!(!cases.matches.is_empty(), "vectors must load");
        for p in &cases.patterns.valid {
            assert!(valid_pattern(p), "valid: {p}");
        }
        for p in &cases.patterns.invalid {
            assert!(!valid_pattern(p), "invalid: {p}");
        }
        for c in &cases.matches {
            assert_eq!(origin_allowed(&c.url, &c.patterns), c.allowed, "{}", c.url);
        }
    }

    #[test]
    fn displays_origins_without_default_ports() {
        let o = address_origin("https://app.example.com:443/x").map(|o| o.display());
        assert_eq!(o.as_deref(), Some("https://app.example.com"));
        let o = address_origin("http://localhost:3000/").map(|o| o.display());
        assert_eq!(o.as_deref(), Some("http://localhost:3000"));
    }
}
