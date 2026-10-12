//! OS keychain availability. If the keychain cannot be used, secret persistence is disabled and the UI explains
//! the limitation. Secrets are NEVER written to a plaintext fallback (milestone 02 failure behaviour).

use serde::Serialize;

pub const SERVICE: &str = "dev.projectbrowser.manager";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KeychainStatus {
    pub available: bool,
    /// Machine-readable reason when unavailable.
    pub reason: Option<&'static str>,
}

/// Writes, reads back and deletes a random probe value under this app's service name.
pub fn probe() -> KeychainStatus {
    let Ok(value) = pb_runtime::random_hex(16) else {
        return KeychainStatus {
            available: false,
            reason: Some("rng_unavailable"),
        };
    };
    let entry = match keyring::Entry::new(SERVICE, "availability-probe") {
        Ok(e) => e,
        Err(_) => {
            return KeychainStatus {
                available: false,
                reason: Some("keychain_unavailable"),
            };
        }
    };
    if entry.set_password(&value).is_err() {
        return KeychainStatus {
            available: false,
            reason: Some("write_failed"),
        };
    }
    let ok = entry.get_password().map(|v| v == value).unwrap_or(false);
    let _ = entry.delete_credential();
    if ok {
        KeychainStatus {
            available: true,
            reason: None,
        }
    } else {
        KeychainStatus {
            available: false,
            reason: Some("read_back_failed"),
        }
    }
}

/// Stores a secret only when the keychain is available; otherwise refuses (no plaintext fallback).
pub fn store_secret(
    status: &KeychainStatus,
    account: &str,
    secret: &str,
) -> Result<(), &'static str> {
    if !status.available {
        return Err("KEYCHAIN_UNAVAILABLE");
    }
    keyring::Entry::new(SERVICE, account)
        .and_then(|e| e.set_password(secret))
        .map_err(|_| "KEYCHAIN_WRITE_FAILED")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_keychain_refuses_instead_of_falling_back() {
        let unavailable = KeychainStatus {
            available: false,
            reason: Some("keychain_unavailable"),
        };
        assert_eq!(
            store_secret(&unavailable, "refresh-token", "secret"),
            Err("KEYCHAIN_UNAVAILABLE")
        );
    }

    #[test]
    fn probe_reports_a_definite_status() {
        let status = probe(); // CI machines may or may not have a usable keychain; either answer must be explicit
        assert_eq!(status.available, status.reason.is_none());
    }
}
