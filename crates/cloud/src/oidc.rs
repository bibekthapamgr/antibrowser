//! OpenID Connect on the desktop: discovery, the authorization request (Authorization Code + PKCE S256, state, nonce),
//! the callback checks and the code exchange. Only the ID token is kept from the provider; the provider's own access
//! and refresh tokens are dropped, because the API issues the session this device uses.

use crate::http::{Http, HttpError, Method};
use crate::pkce::Attempt;
use serde::Deserialize;
use url::Url;

/// Sign-in settings published by our API (`GET /v1/auth/config`).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ProviderConfig {
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

/// The provider endpoints we use, from its discovery document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SignInError {
    #[error("the sign-in service could not be reached")]
    Unavailable,
    #[error("the sign-in service is not set up correctly")]
    Misconfigured,
    #[error("the sign-in response came from an unexpected issuer")]
    IssuerMismatch,
    /// An OAuth error code from the provider (`access_denied`, `login_required`, ...), sanitized.
    #[error("the sign-in service reported: {0}")]
    Provider(String),
    #[error("the sign-in could not be completed")]
    ExchangeFailed,
}

impl SignInError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "SIGN_IN_UNAVAILABLE",
            Self::Misconfigured => "SIGN_IN_MISCONFIGURED",
            Self::IssuerMismatch => "SIGN_IN_ISSUER_MISMATCH",
            Self::Provider(_) => "SIGN_IN_REFUSED",
            Self::ExchangeFailed => "SIGN_IN_FAILED",
        }
    }
}

impl From<HttpError> for SignInError {
    fn from(e: HttpError) -> Self {
        match e {
            HttpError::Offline => Self::Unavailable,
            _ => Self::Misconfigured,
        }
    }
}

#[derive(Deserialize)]
struct DiscoveryDoc {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    code_challenge_methods_supported: Option<Vec<String>>,
}

/// Fetches and checks the discovery document: its issuer must equal the configured one exactly, and both endpoints
/// must pass the transport rules (https, or loopback http in development).
pub fn discover(http: &Http, issuer: &str) -> Result<Discovery, SignInError> {
    let base = Url::parse(issuer).map_err(|_| SignInError::Misconfigured)?;
    http.check(&base)?;
    let url = Url::parse(&format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    ))
    .map_err(|_| SignInError::Misconfigured)?;
    let res = http.request(Method::Get, &url, None, &[], None)?;
    if !res.ok() {
        return Err(SignInError::Misconfigured);
    }
    let doc: DiscoveryDoc =
        serde_json::from_slice(&res.body).map_err(|_| SignInError::Misconfigured)?;
    if doc.issuer != issuer {
        return Err(SignInError::IssuerMismatch);
    }
    if let Some(methods) = &doc.code_challenge_methods_supported
        && !methods.iter().any(|m| m == "S256")
    {
        return Err(SignInError::Misconfigured);
    }
    let authorization_endpoint =
        Url::parse(&doc.authorization_endpoint).map_err(|_| SignInError::Misconfigured)?;
    let token_endpoint = Url::parse(&doc.token_endpoint).map_err(|_| SignInError::Misconfigured)?;
    http.check(&authorization_endpoint)?;
    http.check(&token_endpoint)?;
    Ok(Discovery {
        issuer: doc.issuer,
        authorization_endpoint,
        token_endpoint,
    })
}

/// The URL opened in the system browser. `reauth` asks the provider for a fresh login (used before sensitive actions
/// such as an ownership transfer).
pub fn authorization_url(
    d: &Discovery,
    cfg: &ProviderConfig,
    attempt: &Attempt,
    reauth: bool,
) -> Url {
    let mut url = d.authorization_endpoint.clone();
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &cfg.client_id)
            .append_pair("redirect_uri", &cfg.redirect_uri)
            .append_pair("scope", &cfg.scopes.join(" "))
            .append_pair("state", &attempt.state)
            .append_pair("nonce", &attempt.nonce)
            .append_pair("code_challenge", &attempt.challenge())
            .append_pair("code_challenge_method", "S256");
        if reauth {
            q.append_pair("prompt", "login").append_pair("max_age", "0");
        }
    }
    url
}

/// What arrived on the redirect (already validated for shape by the deep-link parser).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Callback {
    pub state: String,
    pub code: Option<String>,
    pub error: Option<String>,
    pub iss: Option<String>,
}

/// Returns the authorization code, or why the attempt failed. When the provider names itself in the response
/// (RFC 9207 `iss`), it must be the configured issuer.
pub fn check_callback(cb: &Callback, expected_issuer: &str) -> Result<String, SignInError> {
    if let Some(iss) = &cb.iss
        && iss != expected_issuer
    {
        return Err(SignInError::IssuerMismatch);
    }
    if let Some(error) = &cb.error {
        return Err(SignInError::Provider(sanitize_error(error)));
    }
    cb.code.clone().ok_or(SignInError::ExchangeFailed)
}

fn sanitize_error(e: &str) -> String {
    let clean: String = e
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(40)
        .collect();
    if clean.is_empty() {
        "error".into()
    } else {
        clean
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: Option<String>,
}

/// Exchanges the code at the provider's token endpoint (public client: the PKCE verifier proves this is the device
/// that started the attempt). Returns the ID token only.
pub fn exchange_code(
    http: &Http,
    d: &Discovery,
    cfg: &ProviderConfig,
    code: &str,
    verifier: &str,
) -> Result<String, SignInError> {
    let res = http.post_form(
        &d.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &cfg.redirect_uri),
            ("client_id", &cfg.client_id),
            ("code_verifier", verifier),
        ],
    )?;
    if !res.ok() {
        let error = serde_json::from_slice::<TokenError>(&res.body)
            .ok()
            .and_then(|e| e.error);
        return Err(match error {
            Some(e) => SignInError::Provider(sanitize_error(&e)),
            None => SignInError::ExchangeFailed,
        });
    }
    let body: TokenResponse =
        serde_json::from_slice(&res.body).map_err(|_| SignInError::ExchangeFailed)?;
    match body.id_token {
        Some(t) if t.split('.').count() == 3 && t.len() <= 8192 => Ok(t),
        _ => Err(SignInError::ExchangeFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            issuer: "https://id.example.test/realms/pb".into(),
            client_id: "pb-desktop".into(),
            redirect_uri: "projectbrowser://auth/callback".into(),
            scopes: vec!["openid".into(), "email".into(), "profile".into()],
        }
    }

    fn discovery() -> Discovery {
        Discovery {
            issuer: cfg().issuer,
            authorization_endpoint: Url::parse(
                "https://id.example.test/realms/pb/protocol/openid-connect/auth",
            )
            .unwrap_or_else(|e| panic!("{e}")),
            token_endpoint: Url::parse(
                "https://id.example.test/realms/pb/protocol/openid-connect/token",
            )
            .unwrap_or_else(|e| panic!("{e}")),
        }
    }

    #[test]
    fn authorization_url_carries_pkce_state_and_nonce() -> Result<(), getrandom::Error> {
        let attempt = Attempt::new()?;
        let url = authorization_url(&discovery(), &cfg(), &attempt, false);
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(q.get("client_id").map(String::as_str), Some("pb-desktop"));
        assert_eq!(
            q.get("redirect_uri").map(String::as_str),
            Some("projectbrowser://auth/callback")
        );
        assert_eq!(
            q.get("scope").map(String::as_str),
            Some("openid email profile")
        );
        assert_eq!(q.get("state"), Some(&attempt.state));
        assert_eq!(q.get("nonce"), Some(&attempt.nonce));
        assert_eq!(q.get("code_challenge"), Some(&attempt.challenge()));
        assert_eq!(
            q.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        // The verifier itself never leaves the manager.
        assert!(!url.as_str().contains(&attempt.verifier));
        assert!(!q.contains_key("prompt"));

        let re = authorization_url(&discovery(), &cfg(), &attempt, true);
        let q: std::collections::HashMap<_, _> = re.query_pairs().into_owned().collect();
        assert_eq!(q.get("prompt").map(String::as_str), Some("login"));
        assert_eq!(q.get("max_age").map(String::as_str), Some("0"));
        Ok(())
    }

    #[test]
    fn callbacks_from_another_issuer_or_with_errors_are_refused() {
        let issuer = cfg().issuer;
        let ok = Callback {
            state: "s".into(),
            code: Some("c0de".into()),
            error: None,
            iss: Some(issuer.clone()),
        };
        assert_eq!(check_callback(&ok, &issuer), Ok("c0de".into()));
        let no_iss = Callback {
            iss: None,
            ..ok.clone()
        };
        assert_eq!(check_callback(&no_iss, &issuer), Ok("c0de".into()));
        let mixed_up = Callback {
            iss: Some("https://evil.example.test".into()),
            ..ok.clone()
        };
        assert_eq!(
            check_callback(&mixed_up, &issuer),
            Err(SignInError::IssuerMismatch)
        );
        let denied = Callback {
            code: None,
            error: Some("access_denied<script>".into()),
            ..ok
        };
        assert_eq!(
            check_callback(&denied, &issuer),
            Err(SignInError::Provider("access_deniedscript".into()))
        );
    }
}
