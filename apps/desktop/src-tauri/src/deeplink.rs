//! Controlled app deep links (milestone 02, step 6).
//!
//! The only accepted form is `projectbrowser://auth/callback?state=<s>&code=<c>` (or `error=<e>` instead of the code),
//! optionally with the provider's `iss` (RFC 9207), `session_state` and `error_description`/`error_uri`, with strict
//! character sets and lengths. Anything else is rejected. A deep link is DATA: it is never interpreted as a command,
//! path or URL to open, and its contents are never logged. The `state` must match a one-time transaction created by
//! this device when the user started signing in (milestone 06); replays and expired states fail.

use pb_storage::{AuthTxError, LocalStore};
use serde::Serialize;

pub const SCHEME: &str = "projectbrowser";
const TOKEN_MIN: usize = 16;
const TOKEN_MAX: usize = 512;
const URL_MAX: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthCallback {
    pub state: String,
    pub code: Option<String>,
    pub error: Option<String>,
    /// The issuer named in the response (checked against the configured provider by the sign-in code).
    pub iss: Option<String>,
}

/// An `https` (or loopback `http`) issuer URL of bounded length.
fn issuer_ok(s: &str) -> bool {
    s.len() <= 512
        && url::Url::parse(s).is_ok_and(|u| {
            matches!(u.scheme(), "https" | "http") && u.host().is_some() && u.query().is_none()
        })
}

/// Free text the provider may add to an error; never shown or logged, only bounded.
fn text_ok(s: &str) -> bool {
    s.len() <= 512 && !s.chars().any(char::is_control)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    TooLong,
    NotAUrl,
    WrongScheme,
    UnknownRoute,
    UnexpectedParts,
    BadParameter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Structurally valid and bound to a live one-time transaction.
    Accepted,
    Rejected(Rejection),
    UnknownTransaction,
    ExpiredTransaction,
    ReplayedTransaction,
    StoreUnavailable,
}

fn token_ok(s: &str) -> bool {
    (TOKEN_MIN..=TOKEN_MAX).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
}

pub fn parse(raw: &str) -> Result<AuthCallback, Rejection> {
    if raw.len() > URL_MAX {
        return Err(Rejection::TooLong);
    }
    let url = url::Url::parse(raw).map_err(|_| Rejection::NotAUrl)?;
    if url.scheme() != SCHEME {
        return Err(Rejection::WrongScheme);
    }
    if url.host_str() != Some("auth") || url.path() != "/callback" {
        return Err(Rejection::UnknownRoute);
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(Rejection::UnexpectedParts);
    }
    let (mut state, mut code, mut error, mut iss) = (None, None, None, None);
    let (mut session_state, mut description, mut error_uri) = (None, None, None);
    for (k, v) in url.query_pairs() {
        let (slot, valid) = match k.as_ref() {
            "state" => (&mut state, token_ok(&v)),
            "code" => (&mut code, token_ok(&v)),
            "error" => (
                &mut error,
                token_ok(&v)
                    || (v.len() >= 3
                        && v.len() <= 64
                        && v.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')),
            ),
            "iss" => (&mut iss, issuer_ok(&v)),
            "session_state" => (
                &mut session_state,
                token_ok(&v)
                    || (v.len() >= 8
                        && v.len() <= 128
                        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')),
            ),
            "error_description" => (&mut description, text_ok(&v)),
            "error_uri" => (&mut error_uri, text_ok(&v)),
            _ => return Err(Rejection::UnexpectedParts),
        };
        if slot.is_some() || !valid {
            return Err(Rejection::BadParameter); // duplicates and bad characters are refused
        }
        *slot = Some(v.into_owned());
    }
    let state = state.ok_or(Rejection::BadParameter)?;
    if code.is_none() == error.is_none() {
        return Err(Rejection::BadParameter); // exactly one of code / error
    }
    Ok(AuthCallback {
        state,
        code,
        error,
        iss,
    })
}

/// Validates and binds a received deep link. On [`Outcome::Accepted`] the callback is returned for the sign-in code
/// (`account.rs`), which exchanges the code.
pub fn handle(raw: &str, store: Option<&LocalStore>) -> (Outcome, Option<AuthCallback>) {
    let callback = match parse(raw) {
        Ok(c) => c,
        Err(r) => return (Outcome::Rejected(r), None),
    };
    let Some(store) = store else {
        return (Outcome::StoreUnavailable, None);
    };
    match store.consume_auth_transaction(&callback.state) {
        Ok(Ok(())) => (Outcome::Accepted, Some(callback)),
        Ok(Err(AuthTxError::Unknown)) => (Outcome::UnknownTransaction, None),
        Ok(Err(AuthTxError::Expired)) => (Outcome::ExpiredTransaction, None),
        Ok(Err(AuthTxError::Replayed)) => (Outcome::ReplayedTransaction, None),
        Err(_) => (Outcome::StoreUnavailable, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "s0me-st4te_value.0123";
    const CODE: &str = "c0de-v4lue_0123456789";

    #[test]
    fn accepts_only_the_callback_shape() {
        let ok = parse(&format!(
            "projectbrowser://auth/callback?state={STATE}&code={CODE}"
        ));
        assert_eq!(ok.map(|c| c.state), Ok(STATE.to_owned()));
        let err_form = parse(&format!(
            "projectbrowser://auth/callback?state={STATE}&error=access_denied_by_user"
        ));
        assert!(err_form.is_ok());

        let long = "a".repeat(3000);
        let cases: Vec<(String, Rejection)> = vec![
            (
                format!("projectbrowser://auth/callback?state={long}"),
                Rejection::TooLong,
            ),
            ("not a url".into(), Rejection::NotAUrl),
            (
                format!("https://auth/callback?state={STATE}&code={CODE}"),
                Rejection::WrongScheme,
            ),
            (
                format!("file:///auth/callback?state={STATE}&code={CODE}"),
                Rejection::WrongScheme,
            ),
            (
                format!("projectbrowser://open/callback?state={STATE}&code={CODE}"),
                Rejection::UnknownRoute,
            ),
            (
                "projectbrowser://auth/../../bin/sh".into(),
                Rejection::UnknownRoute,
            ),
            (
                "projectbrowser://launch?profile=x&args=--no-sandbox".into(),
                Rejection::UnknownRoute,
            ),
            (
                format!("projectbrowser://auth/callback?state={STATE}&code={CODE}&cmd=rm"),
                Rejection::UnexpectedParts,
            ),
            (
                format!("projectbrowser://user:pw@auth/callback?state={STATE}&code={CODE}"),
                Rejection::UnexpectedParts,
            ),
            (
                format!("projectbrowser://auth/callback?state={STATE}&code={CODE}#frag"),
                Rejection::UnexpectedParts,
            ),
            (
                format!("projectbrowser://auth/callback?state={STATE}&state={STATE}&code={CODE}"),
                Rejection::BadParameter,
            ),
            (
                format!("projectbrowser://auth/callback?state=$(reboot)&code={CODE}"),
                Rejection::BadParameter,
            ),
            (
                format!("projectbrowser://auth/callback?state=short&code={CODE}"),
                Rejection::BadParameter,
            ),
            (
                format!("projectbrowser://auth/callback?state={STATE}"),
                Rejection::BadParameter,
            ),
            (
                format!(
                    "projectbrowser://auth/callback?state={STATE}&code={CODE}&error=x0123456789abcdef"
                ),
                Rejection::BadParameter,
            ),
        ];
        for (raw, expected) in cases {
            assert_eq!(parse(&raw).err(), Some(expected), "{raw}");
        }
    }

    #[test]
    fn accepts_provider_extras_but_validates_them() {
        // The shape Keycloak sends: state, session_state, iss, code.
        let ok = parse(&format!(
            "projectbrowser://auth/callback?state={STATE}&session_state=1b9b1a3c-7f7e-4c38-9c5e-0a4c2f0f1d2e&iss=https%3A%2F%2Fid.example.test%2Frealms%2Fpb&code={CODE}"
        ));
        assert_eq!(
            ok.map(|c| c.iss),
            Ok(Some("https://id.example.test/realms/pb".to_owned()))
        );
        let err = parse(&format!(
            "projectbrowser://auth/callback?state={STATE}&error=access_denied&error_description=User%20cancelled"
        ));
        assert_eq!(err.map(|c| c.error), Ok(Some("access_denied".to_owned())));
        for bad in [
            format!(
                "projectbrowser://auth/callback?state={STATE}&code={CODE}&iss=javascript%3Aalert(1)"
            ),
            format!(
                "projectbrowser://auth/callback?state={STATE}&code={CODE}&iss=https%3A%2F%2Fa.test%2F%3Fx%3D1"
            ),
            format!(
                "projectbrowser://auth/callback?state={STATE}&code={CODE}&error_description=a%0Ab"
            ),
            format!(
                "projectbrowser://auth/callback?state={STATE}&code={CODE}&session_state=%24%28x%29"
            ),
        ] {
            assert_eq!(parse(&bad).err(), Some(Rejection::BadParameter), "{bad}");
        }
    }

    #[test]
    fn binds_to_a_one_time_transaction() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store =
            LocalStore::open(&dir.path().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
        let link = format!("projectbrowser://auth/callback?state={STATE}&code={CODE}");
        assert_eq!(handle(&link, Some(&store)).0, Outcome::UnknownTransaction);
        store
            .begin_auth_transaction(STATE, 300)
            .unwrap_or_else(|e| panic!("{e}"));
        let (outcome, callback) = handle(&link, Some(&store));
        assert_eq!(outcome, Outcome::Accepted);
        assert_eq!(callback.and_then(|c| c.code).as_deref(), Some(CODE));
        assert_eq!(
            handle(&link, Some(&store)),
            (Outcome::ReplayedTransaction, None)
        );
        assert_eq!(
            handle("projectbrowser://evil", Some(&store)).0,
            Outcome::Rejected(Rejection::UnknownRoute)
        );
    }
}
