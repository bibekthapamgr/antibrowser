//! Random values for one sign-in attempt (RFC 6749 state, OIDC nonce, RFC 7636 PKCE with S256).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// `bytes` random bytes, base64url without padding.
pub fn random_token(bytes: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// The S256 challenge of a verifier: base64url(SHA-256(verifier)).
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Everything one attempt needs. Kept in the manager's memory only; `state` is also recorded (hashed) as a one-time
/// transaction in the local store so the callback can be bound to it exactly once.
#[derive(Clone)]
pub struct Attempt {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
}

impl Attempt {
    pub fn new() -> Result<Self, getrandom::Error> {
        Ok(Self {
            state: random_token(32)?,
            nonce: random_token(24)?,
            // 32 bytes -> 43 characters, inside RFC 7636's 43..=128.
            verifier: random_token(32)?,
        })
    }

    pub fn challenge(&self) -> String {
        challenge(&self.verifier)
    }
}

// Never print the secrets of an attempt.
impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Attempt(..)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn attempts_are_random_and_well_formed() -> Result<(), getrandom::Error> {
        let a = Attempt::new()?;
        let b = Attempt::new()?;
        assert_ne!(a.state, b.state);
        assert_ne!(a.verifier, b.verifier);
        assert_eq!(a.verifier.len(), 43);
        assert!(
            a.verifier
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
        assert_eq!(format!("{a:?}"), "Attempt(..)");
        Ok(())
    }
}
