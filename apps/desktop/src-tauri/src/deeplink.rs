//! Controlled app deep links (milestone 02, step 6).
//!
//! The only accepted form is `projectbrowser://auth/callback?state=<s>&code=<c>` (plus an optional `error`), with
//! strict character sets and lengths. Anything else is rejected. A deep link is DATA: it is never interpreted as a
//! command, path or URL to open, and its contents are never logged. The `state` must match a one-time transaction
//! created by this device (milestone 06 starts transactions when the user signs in); replays and expired states fail.

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
    let (mut state, mut code, mut error) = (None, None, None);
    for (k, v) in url.query_pairs() {
        let slot = match k.as_ref() {
            "state" => &mut state,
            "code" => &mut code,
            "error" => &mut error,
            _ => return Err(Rejection::UnexpectedParts),
        };
        if slot.is_some() || !token_ok(&v) {
            return Err(Rejection::BadParameter); // duplicates and bad characters are refused
        }
        *slot = Some(v.into_owned());
    }
    let state = state.ok_or(Rejection::BadParameter)?;
    if code.is_none() == error.is_none() {
        return Err(Rejection::BadParameter); // exactly one of code / error
    }
    Ok(AuthCallback { state, code, error })
}

/// Validates and binds a received deep link. The authorization code exchange itself is milestone 06.
pub fn handle(raw: &str, store: Option<&LocalStore>) -> Outcome {
    let callback = match parse(raw) {
        Ok(c) => c,
        Err(r) => return Outcome::Rejected(r),
    };
    let Some(store) = store else {
        return Outcome::StoreUnavailable;
    };
    match store.consume_auth_transaction(&callback.state) {
        Ok(Ok(())) => Outcome::Accepted,
        Ok(Err(AuthTxError::Unknown)) => Outcome::UnknownTransaction,
        Ok(Err(AuthTxError::Expired)) => Outcome::ExpiredTransaction,
        Ok(Err(AuthTxError::Replayed)) => Outcome::ReplayedTransaction,
        Err(_) => Outcome::StoreUnavailable,
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
    fn binds_to_a_one_time_transaction() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store =
            LocalStore::open(&dir.path().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
        let link = format!("projectbrowser://auth/callback?state={STATE}&code={CODE}");
        assert_eq!(handle(&link, Some(&store)), Outcome::UnknownTransaction);
        store
            .begin_auth_transaction(STATE, 300)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(handle(&link, Some(&store)), Outcome::Accepted);
        assert_eq!(handle(&link, Some(&store)), Outcome::ReplayedTransaction);
        assert_eq!(
            handle("projectbrowser://evil", Some(&store)),
            Outcome::Rejected(Rejection::UnknownRoute)
        );
    }
}
