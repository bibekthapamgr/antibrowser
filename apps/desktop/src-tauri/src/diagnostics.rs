//! Diagnostics reports (milestone 09, ADR-0016): what support needs to understand a problem — versions, operation
//! ids, error codes and summarized failures — and nothing that identifies a person or opens an account.
//!
//! The report is built from a fixed set of sections that never include proxy addresses or logins, page addresses,
//! cookies, notes, or profile and client names (profiles appear by id). Every string in it then goes through
//! [`Redactor`]: web and other addresses, e-mail addresses, IP addresses, the home folder and the user name, values
//! next to secret-sounding words, and long opaque tokens are replaced. Keys that sound secret lose their value.
//! The person sees the exact text before it is saved ([`Previews`]); the report is limited to [`MAX_REPORT_BYTES`]
//! (the longest lists are shortened first) and a preview is kept in memory for [`PREVIEW_TTL`] only. Nothing is
//! uploaded: the person saves the file and decides whom to send it to.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_REPORT_BYTES: usize = 1024 * 1024;
pub const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PREVIEWS: usize = 3;

/// Words after which a value is treated as secret (`password: x`, `token=x`, `Bearer x`).
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "bearer",
    "cookie",
    "session",
    "credential",
    "private_key",
];

/// Object keys whose value is replaced whatever it looks like.
fn secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "credential",
        "authorization",
        "cookie",
        "api_key",
        "apikey",
        "private_key",
        "username",
        "user_name",
        "login",
        "email",
        "notes",
        "note",
        "url",
        "urls",
        "host",
        "egress_ip",
        "ip",
        "address",
    ]
    .iter()
    .any(|w| k == *w || k.ends_with(&format!("_{w}")) || k.starts_with(&format!("{w}_")))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Redactions {
    pub addresses: u32,
    pub emails: u32,
    pub ip_addresses: u32,
    pub paths: u32,
    pub user_names: u32,
    pub secrets: u32,
    pub tokens: u32,
}

impl Redactions {
    pub fn total(&self) -> u32 {
        self.addresses
            + self.emails
            + self.ip_addresses
            + self.paths
            + self.user_names
            + self.secrets
            + self.tokens
    }
}

pub struct Redactor {
    homes: Vec<String>,
    users: Vec<String>,
}

/// Our own ids (`prf_…`, `org_…`, `op_12`): kept, they are what support needs to follow an operation.
fn own_id(s: &str) -> bool {
    let crockford = |b: u8| {
        b.is_ascii_digit() || (b.is_ascii_uppercase() && !matches!(b, b'I' | b'L' | b'O' | b'U'))
    };
    match s.split_once('_') {
        Some((prefix, body))
            if prefix.len() == 3 && prefix.bytes().all(|b| b.is_ascii_lowercase()) =>
        {
            body.len() == 26 && body.bytes().all(crockford)
        }
        Some(("op", n)) => !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_digit()),
        Some(("run", hex)) => hex.len() == 24 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        _ => false,
    }
}

fn is_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 3
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u16>().is_ok_and(|n| n <= 255)
        })
}

/// `::1`, `fe80::1`, `2001:db8:0:0:0:0:0:1` (not times such as `12:30:45`).
fn is_ipv6(s: &str) -> bool {
    let colons = s.bytes().filter(|b| *b == b':').count();
    (s.contains("::") || colons == 7)
        && s.len() >= 3
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
}

/// Replaces `needle` in any letter case (ASCII and Unicode letters with same-length lower case).
fn replace_ignoring_case(text: &str, needle: &str, with: &str, count: &mut u32) -> String {
    if needle.is_empty() {
        return text.to_owned();
    }
    let lower = text.to_lowercase();
    let needle_lower = needle.to_lowercase();
    if lower.len() != text.len() || needle_lower.len() != needle.len() {
        let n = text.matches(needle).count() as u32;
        *count += n;
        return text.replace(needle, with);
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(pos) = lower[i..].find(&needle_lower) {
        out.push_str(&text[i..i + pos]);
        out.push_str(with);
        *count += 1;
        i += pos + needle_lower.len();
    }
    out.push_str(&text[i..]);
    out
}

fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn has_scheme(s: &str) -> bool {
    let Some(i) = s.find("://") else {
        return false;
    };
    let scheme = &s[..i];
    !scheme.is_empty()
        && scheme.len() <= 20
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

fn tokenish(s: &str) -> bool {
    s.len() >= 24
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+' | b'/' | b'=')
        })
        && s.bytes().any(|b| b.is_ascii_digit())
        && s.bytes().any(|b| b.is_ascii_alphabetic())
        && !own_id(s)
}

/// Splits text into tokens (runs of non-separator characters) and the separators between them.
fn pieces(text: &str) -> Vec<(bool, &str)> {
    let sep = |c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '"' | '\'' | ',' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ';' | '|'
            )
    };
    let mut out = vec![];
    let mut start = 0;
    let mut in_token = false;
    for (i, c) in text.char_indices() {
        let is_sep = sep(c);
        if i == 0 {
            in_token = !is_sep;
            continue;
        }
        if is_sep == in_token {
            out.push((in_token, &text[start..i]));
            start = i;
            in_token = !is_sep;
        }
    }
    if start < text.len() {
        out.push((in_token, &text[start..]));
    }
    out
}

impl Redactor {
    pub fn for_this_computer() -> Self {
        let homes = ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .filter(|h| h.len() > 1)
            .collect();
        let users = ["USER", "USERNAME", "LOGNAME"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .filter(|u| u.chars().count() > 2)
            .collect();
        Self::new(homes, users)
    }

    pub fn new(homes: Vec<String>, users: Vec<String>) -> Self {
        let mut homes: Vec<String> = homes;
        homes.sort_by_key(|h| std::cmp::Reverse(h.len()));
        Self { homes, users }
    }

    /// Home folder first (so paths stay readable as `~/...`), then addresses, e-mail and IP addresses, secrets and
    /// tokens, then the user name wherever it is left.
    pub fn scrub(&self, text: &str, counts: &mut Redactions) -> String {
        let mut text = text.to_owned();
        for home in &self.homes {
            let n = text.matches(home.as_str()).count() as u32;
            if n > 0 {
                counts.paths += n;
                text = text.replace(home.as_str(), "~");
            }
        }
        let mut out = String::with_capacity(text.len());
        let mut secret_next = false;
        for (is_token, piece) in pieces(&text) {
            if !is_token {
                out.push_str(piece);
                continue;
            }
            let lower = piece.to_ascii_lowercase();
            let trimmed = piece.trim_end_matches(['.', ':', '!', '?']);
            let tail = &piece[trimmed.len()..];
            let is_word = |w: &&str| lower.trim_end_matches([':', '=']) == *w;
            // `password=x`, `token:x`: the word and its value in one piece.
            if let Some((word, value)) = lower.split_once(['=', ':'])
                && !value.is_empty()
                && !has_scheme(piece)
                && SECRET_WORDS
                    .iter()
                    .any(|w| word.trim_start_matches(['-', '_']).ends_with(w))
            {
                out.push_str(&piece[..word.len() + 1]);
                out.push_str("[secret]");
                counts.secrets += 1;
                secret_next = false;
                continue;
            }
            if secret_next && !SECRET_WORDS.iter().any(is_word) {
                if matches!(trimmed, "is" | "=" | ":") {
                    out.push_str(piece);
                    continue;
                }
                out.push_str("[secret]");
                out.push_str(tail);
                counts.secrets += 1;
                secret_next = false;
                continue;
            }
            secret_next = SECRET_WORDS.iter().any(is_word);
            let host = trimmed.split(':').next().unwrap_or("");
            if has_scheme(trimmed) {
                out.push_str("<address>");
                out.push_str(tail);
                counts.addresses += 1;
            } else if is_email(trimmed) {
                out.push_str("<email>");
                out.push_str(tail);
                counts.emails += 1;
            } else if (is_ipv4(host) && trimmed.split(':').count() <= 2) || is_ipv6(trimmed) {
                out.push_str("<ip>");
                out.push_str(tail);
                counts.ip_addresses += 1;
            } else if tokenish(trimmed) {
                out.push_str("[redacted]");
                out.push_str(tail);
                counts.tokens += 1;
            } else {
                out.push_str(piece);
            }
        }
        for user in &self.users {
            out = replace_ignoring_case(&out, user, "<user>", &mut counts.user_names);
        }
        out
    }

    /// Scrubs every string (and every key's value that sounds secret) in place.
    pub fn scrub_value(&self, value: &mut Value, counts: &mut Redactions) {
        match value {
            Value::String(s) => *s = self.scrub(s, counts),
            Value::Array(items) => {
                for v in items {
                    self.scrub_value(v, counts);
                }
            }
            Value::Object(map) => {
                let keys: Vec<String> = map.keys().cloned().collect();
                let mut renamed: Vec<(String, String)> = vec![];
                for k in keys {
                    let Some(v) = map.get_mut(&k) else { continue };
                    if secret_key(&k) && !v.is_null() && !matches!(v, Value::Bool(_)) {
                        *v = Value::String("[secret]".into());
                        counts.secrets += 1;
                    } else {
                        self.scrub_value(v, counts);
                    }
                    let clean = self.scrub(&k, counts);
                    if clean != k {
                        renamed.push((k, clean));
                    }
                }
                for (old, new) in renamed {
                    if let Some(v) = map.remove(&old) {
                        map.insert(new, v);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Shortens the longest lists until the pretty-printed report fits. Returns the text and whether anything was cut.
pub fn fit(mut report: Value, limit: usize) -> (String, bool) {
    let mut truncated = false;
    for _ in 0..64 {
        let text = serde_json::to_string_pretty(&report).unwrap_or_default();
        if text.len() <= limit {
            return (text, truncated);
        }
        truncated = true;
        if !halve_longest(&mut report) {
            break;
        }
    }
    let mut map = Map::new();
    map.insert("truncated".into(), Value::Bool(true));
    map.insert(
        "note".into(),
        Value::String("The report was too large and was replaced by this note.".into()),
    );
    (
        serde_json::to_string_pretty(&Value::Object(map)).unwrap_or_default(),
        true,
    )
}

fn longest(v: &mut Value) -> Option<&mut Vec<Value>> {
    let mut best: Option<&mut Vec<Value>> = None;
    let mut best_len = 1;
    let mut stack: Vec<&mut Value> = vec![v];
    while let Some(node) = stack.pop() {
        match node {
            Value::Array(items) => {
                if items.len() > best_len {
                    best_len = items.len();
                    // Children of a list that is replaced as the best are not inspected further.
                    best = Some(items);
                } else {
                    stack.extend(items.iter_mut());
                }
            }
            Value::Object(map) => stack.extend(map.values_mut()),
            _ => {}
        }
    }
    best
}

fn halve_longest(v: &mut Value) -> bool {
    match longest(v) {
        Some(items) => {
            let keep = items.len() / 2;
            items.truncate(keep);
            true
        }
        None => false,
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub preview_id: String,
    pub text: String,
    pub bytes: usize,
    pub limit_bytes: usize,
    pub truncated: bool,
    pub redactions: Redactions,
    pub expires_in_seconds: u64,
}

/// Previews shown to the person, kept in memory until saved or expired.
#[derive(Default)]
pub struct Previews {
    items: Mutex<HashMap<String, (Instant, Preview)>>,
}

impl Previews {
    pub fn put(&self, preview: Preview) {
        if let Ok(mut m) = self.items.lock() {
            m.retain(|_, (at, _)| at.elapsed() < PREVIEW_TTL);
            while m.len() >= MAX_PREVIEWS {
                let oldest = m
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => m.remove(&k),
                    None => break,
                };
            }
            m.insert(preview.preview_id.clone(), (Instant::now(), preview));
        }
    }

    pub fn get(&self, id: &str) -> Option<Preview> {
        let m = self.items.lock().ok()?;
        m.get(id)
            .filter(|(at, _)| at.elapsed() < PREVIEW_TTL)
            .map(|(_, p)| p.clone())
    }

    pub fn remove(&self, id: &str) {
        if let Ok(mut m) = self.items.lock() {
            m.remove(id);
        }
    }
}

/// Error codes counted (most frequent first), for "summarized errors".
pub fn summarize_codes<'a>(codes: impl Iterator<Item = &'a str>) -> Vec<Value> {
    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    for c in codes {
        *counts.entry(c).or_default() += 1;
    }
    let mut list: Vec<(&str, u32)> = counts.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    list.into_iter()
        .take(50)
        .map(|(code, n)| serde_json::json!({ "code": code, "count": n }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn redactor() -> Redactor {
        Redactor::new(
            vec!["/home/maria.k".into(), "C:\\Users\\Maria".into()],
            vec!["maria.k".into(), "Maria".into()],
        )
    }

    #[test]
    fn scrubs_addresses_people_and_secrets_but_keeps_codes_and_ids() {
        let mut c = Redactions::default();
        let r = redactor();
        let token = ["ghp", "_", "Zx9", "Q2w8e7r6t5y4u3i2o1p0aSdF"].concat();
        let text = format!(
            "GET https://shop.example/orders?session=abc failed for maria.k@agency.example via 203.0.113.9:8080 \
             (profile prf_01J9ZSEED0A010000000000000, op_42) token={token} password: hunter22 Bearer {token} \
             data at /home/maria.k/.local/share and C:\\Users\\Maria\\AppData; user MARIA; code PROXY_AUTH_FAILED"
        );
        let out = r.scrub(&text, &mut c);
        for gone in [
            "shop.example",
            "maria.k@",
            "203.0.113.9",
            &token,
            "hunter22",
            "/home/maria.k",
            "Users\\Maria",
            "MARIA",
        ] {
            assert!(!out.contains(gone), "{gone} in {out}");
        }
        for kept in [
            "prf_01J9ZSEED0A010000000000000",
            "op_42",
            "PROXY_AUTH_FAILED",
            "~/.local/share",
        ] {
            assert!(out.contains(kept), "{kept} missing in {out}");
        }
        assert!(
            c.addresses >= 1 && c.emails == 1 && c.ip_addresses == 1 && c.secrets >= 3,
            "{c:?}"
        );
    }

    #[test]
    fn scrubs_nested_values_and_secret_keys() {
        let mut c = Redactions::default();
        let mut v = json!({
            "proxy": { "host": "proxy.provider.example", "password": "pw", "port": 8080 },
            "errors": [{ "message": "connect to http://10.0.0.5/ refused" }],
            "fencing_token": "123",
            "notes": "call +1 555 0100",
            "ok": true,
        });
        redactor().scrub_value(&mut v, &mut c);
        let text = v.to_string();
        for gone in [
            "proxy.provider.example",
            "\"pw\"",
            "10.0.0.5",
            "555 0100",
            "\"123\"",
        ] {
            assert!(!text.contains(gone), "{gone} in {text}");
        }
        assert_eq!(v["proxy"]["port"], 8080);
        assert_eq!(v["ok"], true);
    }

    #[test]
    fn fits_the_size_limit_by_shortening_the_longest_lists() {
        let big: Vec<Value> = (0..20_000)
            .map(|n| json!({ "n": n, "code": "X" }))
            .collect();
        let (text, truncated) = fit(
            json!({ "app": { "version": "0.9.0" }, "activity": big }),
            64 * 1024,
        );
        assert!(truncated);
        assert!(text.len() <= 64 * 1024);
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        assert_eq!(v["app"]["version"], "0.9.0");
        assert!(v["activity"].as_array().is_some_and(|a| !a.is_empty()));
        let (small, cut) = fit(json!({ "a": [1, 2, 3] }), 1024);
        assert!(!cut && small.contains("\"a\""));
    }

    #[test]
    fn previews_expire_and_are_bounded() {
        let p = Previews::default();
        for n in 0..5 {
            p.put(Preview {
                preview_id: format!("d{n}"),
                text: String::new(),
                bytes: 0,
                limit_bytes: MAX_REPORT_BYTES,
                truncated: false,
                redactions: Redactions::default(),
                expires_in_seconds: 600,
            });
        }
        assert!(p.get("d0").is_none() && p.get("d4").is_some());
        p.remove("d4");
        assert!(p.get("d4").is_none());
    }
}
