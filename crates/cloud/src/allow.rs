//! The API requests the manager UI may ask the shell to make for it (with the session's access token, which the UI
//! never sees). Everything else is refused before any network access: sign-in, token, lease, snapshot upload,
//! restore-plan and import endpoints are only called by the shell's own code (a data key or signed URL never reaches
//! the window). Milestone 07 adds read-only backup history and the backup policy, trash and key administration.
//! Milestone 08 adds who has a profile open, access requests, forced takeover, grant capabilities and recovery copies;
//! opening, heartbeats and release stay with the shell (it holds the session's lease and fencing token).
//! Milestone 09 adds client dashboards, tasks, shared bookmarks, the extension policy and the extension inventory; the
//! shell itself reports each profile's installed extensions.

use crate::http::Method;

/// One allowed request shape. Path templates use `{org}`, `{usr}`, `{dev}`, `{inv}`, `{cli}`, `{grt}`, `{prf}`, `{hrq}`,
/// `{tsk}`, `{bkm}` for opaque ids and `{token}` for an invitation token.
struct Rule {
    method: Method,
    template: &'static str,
    /// GET responses kept for offline display (never for paths that carry a token).
    cache: bool,
}

const fn rule(method: Method, template: &'static str) -> Rule {
    Rule {
        method,
        template,
        cache: true,
    }
}

/// Live state (who has a profile open, open requests): never shown from the offline cache.
const fn live(method: Method, template: &'static str) -> Rule {
    Rule {
        method,
        template,
        cache: false,
    }
}

const RULES: &[Rule] = &[
    rule(Method::Get, "/v1/me"),
    rule(Method::Get, "/v1/me/workspaces"),
    rule(Method::Get, "/v1/devices"),
    rule(Method::Post, "/v1/devices/{dev}/revoke"),
    rule(Method::Post, "/v1/organizations"),
    rule(Method::Get, "/v1/orgs/{org}"),
    rule(Method::Patch, "/v1/orgs/{org}"),
    rule(Method::Get, "/v1/orgs/{org}/members"),
    rule(Method::Patch, "/v1/orgs/{org}/members/{usr}"),
    rule(Method::Delete, "/v1/orgs/{org}/members/{usr}"),
    rule(Method::Post, "/v1/orgs/{org}/ownership-transfer"),
    rule(Method::Get, "/v1/orgs/{org}/invitations"),
    rule(Method::Post, "/v1/orgs/{org}/invitations"),
    rule(Method::Post, "/v1/orgs/{org}/invitations/{inv}/revoke"),
    Rule {
        method: Method::Get,
        template: "/v1/invitations/{token}",
        cache: false,
    },
    rule(Method::Post, "/v1/invitations/{token}/accept"),
    rule(Method::Get, "/v1/orgs/{org}/clients"),
    rule(Method::Post, "/v1/orgs/{org}/clients"),
    rule(Method::Get, "/v1/orgs/{org}/clients/{cli}"),
    rule(Method::Patch, "/v1/orgs/{org}/clients/{cli}"),
    rule(Method::Get, "/v1/orgs/{org}/grants"),
    rule(Method::Post, "/v1/orgs/{org}/grants"),
    rule(Method::Patch, "/v1/orgs/{org}/grants/{grt}"),
    rule(Method::Delete, "/v1/orgs/{org}/grants/{grt}"),
    rule(Method::Get, "/v1/orgs/{org}/profiles"),
    rule(Method::Post, "/v1/orgs/{org}/profiles"),
    rule(Method::Get, "/v1/orgs/{org}/profiles/export"),
    rule(Method::Post, "/v1/orgs/{org}/profiles/bulk"),
    rule(Method::Get, "/v1/orgs/{org}/profiles/{prf}"),
    rule(Method::Patch, "/v1/orgs/{org}/profiles/{prf}"),
    rule(Method::Delete, "/v1/orgs/{org}/profiles/{prf}"),
    rule(Method::Get, "/v1/orgs/{org}/audit-events"),
    // Milestone 07: version history (metadata only), policy, trash and key versions.
    rule(Method::Get, "/v1/orgs/{org}/profiles/{prf}/snapshots"),
    rule(Method::Get, "/v1/orgs/{org}/backup-policy"),
    rule(Method::Patch, "/v1/orgs/{org}/backup-policy"),
    rule(Method::Get, "/v1/orgs/{org}/trash"),
    rule(Method::Post, "/v1/orgs/{org}/profiles/{prf}/undelete"),
    rule(Method::Get, "/v1/orgs/{org}/keys"),
    rule(Method::Post, "/v1/orgs/{org}/keys/rotate"),
    // Milestone 08: who has a profile open, access requests, forced takeover and recovery copies.
    live(Method::Get, "/v1/orgs/{org}/profiles/{prf}/leases/current"),
    live(
        Method::Get,
        "/v1/orgs/{org}/profiles/{prf}/handoff-requests",
    ),
    rule(
        Method::Post,
        "/v1/orgs/{org}/profiles/{prf}/handoff-requests",
    ),
    rule(
        Method::Post,
        "/v1/orgs/{org}/profiles/{prf}/handoff-requests/{hrq}/decline",
    ),
    rule(
        Method::Post,
        "/v1/orgs/{org}/profiles/{prf}/handoff-requests/{hrq}/cancel",
    ),
    live(Method::Get, "/v1/orgs/{org}/handoff-requests"),
    rule(Method::Post, "/v1/orgs/{org}/profiles/{prf}/force-takeover"),
    rule(Method::Get, "/v1/orgs/{org}/recovery-copies"),
    // Milestone 09: client dashboard (live: who has profiles open), tasks, bookmarks and the extension policy.
    live(Method::Get, "/v1/orgs/{org}/clients/{cli}/dashboard"),
    rule(Method::Get, "/v1/orgs/{org}/clients/{cli}/tasks"),
    rule(Method::Post, "/v1/orgs/{org}/clients/{cli}/tasks"),
    rule(Method::Patch, "/v1/orgs/{org}/clients/{cli}/tasks/{tsk}"),
    rule(Method::Delete, "/v1/orgs/{org}/clients/{cli}/tasks/{tsk}"),
    rule(Method::Get, "/v1/orgs/{org}/clients/{cli}/bookmarks"),
    rule(Method::Post, "/v1/orgs/{org}/clients/{cli}/bookmarks"),
    rule(
        Method::Patch,
        "/v1/orgs/{org}/clients/{cli}/bookmarks/{bkm}",
    ),
    rule(
        Method::Delete,
        "/v1/orgs/{org}/clients/{cli}/bookmarks/{bkm}",
    ),
    rule(Method::Get, "/v1/orgs/{org}/extension-policy"),
    rule(Method::Put, "/v1/orgs/{org}/extension-policy"),
    rule(Method::Get, "/v1/orgs/{org}/extension-inventory"),
];

const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_id(prefix: &str, s: &str) -> bool {
    s.len() == prefix.len() + 27
        && s.starts_with(prefix)
        && s.as_bytes()[prefix.len()] == b'_'
        && s.as_bytes()[prefix.len() + 1..]
            .iter()
            .all(|b| CROCKFORD.contains(b))
}

fn is_token(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn segment_matches(template: &str, segment: &str) -> bool {
    match template {
        "{org}" => is_id("org", segment),
        "{usr}" => is_id("usr", segment),
        "{dev}" => is_id("dev", segment),
        "{inv}" => is_id("inv", segment),
        "{cli}" => is_id("cli", segment),
        "{grt}" => is_id("grt", segment),
        "{prf}" => is_id("prf", segment),
        "{hrq}" => is_id("hrq", segment),
        "{tsk}" => is_id("tsk", segment),
        "{bkm}" => is_id("bkm", segment),
        "{token}" => is_token(segment),
        literal => literal == segment,
    }
}

/// A request the shell agreed to make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allowed {
    pub method: Method,
    /// Path plus the validated query string.
    pub path_and_query: String,
    /// Key for the offline cache (`None`: never cached).
    pub cache_key: Option<String>,
    pub if_match: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("this request is not available to the manager window")]
    NotAllowed,
    #[error("the request has an invalid parameter")]
    BadParameter,
}

/// Validates a request from the UI. Query parameters are limited to the API's paging and filter keys.
pub fn check(
    method: &str,
    path: &str,
    query: &[(String, String)],
    if_match: Option<&str>,
) -> Result<Allowed, Refused> {
    let method = Method::parse(method).ok_or(Refused::NotAllowed)?;
    if path.len() > 200 || !path.starts_with("/v1/") {
        return Err(Refused::NotAllowed);
    }
    let segments: Vec<&str> = path.split('/').collect();
    let rule = RULES
        .iter()
        .find(|r| {
            let t: Vec<&str> = r.template.split('/').collect();
            r.method == method
                && t.len() == segments.len()
                && t.iter().zip(&segments).all(|(t, s)| segment_matches(t, s))
        })
        .ok_or(Refused::NotAllowed)?;

    let mut pairs = Vec::with_capacity(query.len());
    for (k, v) in query {
        let ok = match k.as_str() {
            "cursor" => {
                v.len() <= 512
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            }
            "limit" => v.parse::<u32>().is_ok_and(|n| (1..=100).contains(&n)),
            "q" => !v.is_empty() && v.chars().count() <= 120 && !v.chars().any(char::is_control),
            "client_id" => is_id("cli", v),
            "user_id" => is_id("usr", v),
            "mine" => v == "true" || v == "false",
            "status" => matches!(v.as_str(), "open" | "done" | "all"),
            _ => false,
        };
        if !ok || method != Method::Get || pairs.iter().any(|(pk, _): &(&str, &str)| *pk == k) {
            return Err(Refused::BadParameter);
        }
        pairs.push((k.as_str(), v.as_str()));
    }
    let query_string = if pairs.is_empty() {
        String::new()
    } else {
        format!(
            "?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(pairs)
                .finish()
        )
    };
    let if_match = match if_match {
        None => None,
        Some(v) => {
            let digits = v.trim_matches('"');
            if digits.is_empty()
                || digits.len() > 10
                || !digits.bytes().all(|b| b.is_ascii_digit())
                || digits.starts_with('0')
                || method == Method::Get
            {
                return Err(Refused::BadParameter);
            }
            Some(format!("\"{digits}\""))
        }
    };
    let path_and_query = format!("{path}{query_string}");
    Ok(Allowed {
        method,
        cache_key: (method == Method::Get && rule.cache).then(|| path_and_query.clone()),
        path_and_query,
        if_match,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "org_01J9ZSEED0ACME000000000000";
    const PRF: &str = "prf_01J9ZSEED0A010000000000000";
    const HRQ: &str = "hrq_01J9ZSEED0A010000000000000";
    const LSE: &str = "lse_01J9ZSEED0A010000000000000";
    const CLI: &str = "cli_01J9ZSEED0AN00000000000000";
    const TSK: &str = "tsk_01J9ZSEED0A010000000000000";
    const BKM: &str = "bkm_01J9ZSEED0A010000000000000";

    fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn allows_the_listed_requests_only() {
        let ok = check(
            "GET",
            &format!("/v1/orgs/{ORG}/profiles"),
            &q(&[("q", "shop & ads"), ("limit", "50")]),
            None,
        );
        let ok = ok.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            ok.path_and_query,
            format!("/v1/orgs/{ORG}/profiles?q=shop+%26+ads&limit=50")
        );
        assert_eq!(ok.cache_key.as_deref(), Some(ok.path_and_query.as_str()));
        let history = check(
            "GET",
            &format!("/v1/orgs/{ORG}/profiles/{PRF}/snapshots"),
            &q(&[("limit", "20")]),
            None,
        );
        assert!(history.is_ok());
        assert!(check("POST", &format!("/v1/orgs/{ORG}/keys/rotate"), &[], None).is_ok());
        // Milestone 08: requests, takeover and recovery copies; live state is never cached.
        let current = check(
            "GET",
            &format!("/v1/orgs/{ORG}/profiles/{PRF}/leases/current"),
            &[],
            None,
        );
        assert_eq!(current.map(|a| a.cache_key), Ok(None));
        let mine = check(
            "GET",
            &format!("/v1/orgs/{ORG}/handoff-requests"),
            &q(&[("mine", "true")]),
            None,
        );
        assert_eq!(mine.map(|a| a.cache_key), Ok(None));
        for (method, path) in [
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/handoff-requests"),
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/handoff-requests/{HRQ}/decline"),
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/handoff-requests/{HRQ}/cancel"),
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/force-takeover"),
            ),
            ("GET", format!("/v1/orgs/{ORG}/recovery-copies")),
            // Milestone 09.
            ("GET", format!("/v1/orgs/{ORG}/clients/{CLI}/tasks")),
            ("POST", format!("/v1/orgs/{ORG}/clients/{CLI}/tasks")),
            ("PATCH", format!("/v1/orgs/{ORG}/clients/{CLI}/tasks/{TSK}")),
            (
                "DELETE",
                format!("/v1/orgs/{ORG}/clients/{CLI}/tasks/{TSK}"),
            ),
            ("GET", format!("/v1/orgs/{ORG}/clients/{CLI}/bookmarks")),
            ("POST", format!("/v1/orgs/{ORG}/clients/{CLI}/bookmarks")),
            (
                "PATCH",
                format!("/v1/orgs/{ORG}/clients/{CLI}/bookmarks/{BKM}"),
            ),
            (
                "DELETE",
                format!("/v1/orgs/{ORG}/clients/{CLI}/bookmarks/{BKM}"),
            ),
            ("GET", format!("/v1/orgs/{ORG}/extension-policy")),
            ("PUT", format!("/v1/orgs/{ORG}/extension-policy")),
            ("GET", format!("/v1/orgs/{ORG}/extension-inventory")),
        ] {
            assert!(check(method, &path, &[], None).is_ok(), "{method} {path}");
        }
        let dashboard = check(
            "GET",
            &format!("/v1/orgs/{ORG}/clients/{CLI}/dashboard"),
            &[],
            None,
        );
        assert_eq!(dashboard.map(|a| a.cache_key), Ok(None));
        assert!(
            check(
                "GET",
                &format!("/v1/orgs/{ORG}/clients/{CLI}/tasks"),
                &q(&[("status", "all")]),
                None
            )
            .is_ok()
        );

        let patch = check(
            "PATCH",
            &format!("/v1/orgs/{ORG}/profiles/{PRF}"),
            &[],
            Some("\"3\""),
        );
        assert_eq!(
            patch.map(|a| (a.if_match, a.cache_key)),
            Ok((Some("\"3\"".into()), None))
        );

        for (method, path) in [
            ("POST", format!("/v1/orgs/{ORG}/profiles/{PRF}/lease")),
            // The session's lease belongs to the shell: opening, heartbeats and release are never the window's.
            ("POST", format!("/v1/orgs/{ORG}/profiles/{PRF}/leases")),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/leases/{LSE}/heartbeat"),
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/leases/{LSE}/release"),
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/handoff-requests/{PRF}/decline"),
            ),
            ("POST", format!("/v1/orgs/{ORG}/profiles/{PRF}/snapshots")),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/snapshots/init"),
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/restore-plans"),
            ),
            (
                "GET",
                format!("/v1/orgs/{ORG}/sync-operations/syn_01M4T7R0Q4FN6G53AWPJQ3CBMK"),
            ),
            ("POST", format!("/v1/orgs/{ORG}/local-import")),
            ("POST", "/v1/auth/token".into()),
            ("POST", "/v1/devices".into()),
            ("GET", "/v2/me".into()),
            ("GET", "/v1/orgs/acme/profiles".into()),
            ("GET", format!("/v1/orgs/{ORG}/profiles/../../auth/config")),
            ("PUT", format!("/v1/orgs/{ORG}")),
            // The shell reports installed extensions itself (with its own device id).
            (
                "PUT",
                format!("/v1/orgs/{ORG}/profiles/{PRF}/extension-report"),
            ),
            ("PATCH", format!("/v1/orgs/{ORG}/clients/{CLI}/tasks/{BKM}")),
            ("GET", format!("/v1/orgs/{ORG}/profiles/{PRF}/extra")),
            ("DELETE", format!("/v1/orgs/{ORG}")),
        ] {
            assert_eq!(
                check(method, &path, &[], None).err(),
                Some(Refused::NotAllowed),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn query_and_if_match_are_validated() {
        let list = format!("/v1/orgs/{ORG}/profiles");
        for bad in [
            q(&[("org_id", ORG)]),
            q(&[("limit", "500")]),
            q(&[("client_id", "x")]),
            q(&[("cursor", "a b")]),
            q(&[("q", "a"), ("q", "b")]),
            q(&[("q", "line\nbreak")]),
            q(&[("mine", "yes")]),
            q(&[("status", "closed")]),
        ] {
            assert_eq!(
                check("GET", &list, &bad, None).err(),
                Some(Refused::BadParameter)
            );
        }
        assert_eq!(
            check("POST", &list, &q(&[("limit", "5")]), None).err(),
            Some(Refused::BadParameter)
        );
        let edit = format!("/v1/orgs/{ORG}/profiles/{PRF}");
        for bad in ["0", "\"\"", "1; x", "99999999999", "W/\"2\""] {
            assert_eq!(
                check("PATCH", &edit, &[], Some(bad)).err(),
                Some(Refused::BadParameter),
                "{bad}"
            );
        }
    }

    #[test]
    fn invitation_tokens_are_never_cached() {
        let token = "A".repeat(43);
        let preview = check("GET", &format!("/v1/invitations/{token}"), &[], None);
        assert_eq!(preview.map(|a| a.cache_key), Ok(None));
        assert_eq!(
            check("GET", "/v1/invitations/short", &[], None).err(),
            Some(Refused::NotAllowed)
        );
    }
}
