//! Desktop side of milestone 06: sign-in through the system browser and the control-plane API client.
//!
//! - [`pkce`]: random state, nonce and PKCE (S256) values.
//! - [`oidc`]: provider discovery, the authorization URL, callback checks and the code exchange. Only the ID token is
//!   kept from the provider's response; it is sent once to our API, which issues the device-bound session.
//! - [`http`]: HTTPS-only transport (plain http only to loopback addresses, for a developer's local server), no
//!   redirects (a bearer token is never forwarded to another origin), bounded bodies, offline detection.
//! - [`allow`]: the fixed set of API requests the manager UI may ask the shell to make on its behalf.
//!
//! Tokens never cross into the webview, and nothing here logs a token, code or verifier.

pub mod allow;
pub mod http;
pub mod oidc;
pub mod pkce;

pub use http::{Http, HttpError, Method, Response};
