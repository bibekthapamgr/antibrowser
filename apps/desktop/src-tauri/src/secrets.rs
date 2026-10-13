//! OS keychain availability. If the keychain cannot be used, secret persistence is disabled and the UI explains
//! the limitation. Secrets are NEVER written to a plaintext fallback (milestone 02 failure behaviour).

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "dev.projectbrowser.manager";

/// Where secrets (proxy logins) are kept. The manager uses the OS keychain ([`KeychainStore`]); tests use
/// [`MemoryStore`]. Errors are stable codes; no OS error text is passed on.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), &'static str>;
    /// `Ok(None)`: no entry (it was deleted outside the app, or never saved).
    fn get(&self, account: &str) -> Result<Option<String>, &'static str>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, account: &str) -> Result<(), &'static str>;
}

/// The OS keychain (macOS Keychain, Windows Credential Manager, Linux kernel keyring) under [`SERVICE`].
pub struct KeychainStore;

impl SecretStore for KeychainStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), &'static str> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|_| "KEYCHAIN_WRITE_FAILED")
    }
    fn get(&self, account: &str) -> Result<Option<String>, &'static str> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "KEYCHAIN_UNAVAILABLE")?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("KEYCHAIN_READ_FAILED"),
        }
    }
    fn delete(&self, account: &str) -> Result<(), &'static str> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "KEYCHAIN_UNAVAILABLE")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("KEYCHAIN_WRITE_FAILED"),
        }
    }
}

/// In-memory secrets for tests (and for inspecting exactly what would be stored).
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    /// Every stored account name (never the values).
    pub fn accounts(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .entries
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        out.sort();
        out
    }
    /// Removes an entry behind the app's back (simulates a user deleting it in the keychain app).
    pub fn forget(&self, account: &str) {
        if let Ok(mut m) = self.entries.lock() {
            m.remove(account);
        }
    }
}

impl SecretStore for MemoryStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), &'static str> {
        self.entries
            .lock()
            .map_err(|_| "KEYCHAIN_WRITE_FAILED")?
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
    fn get(&self, account: &str) -> Result<Option<String>, &'static str> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "KEYCHAIN_READ_FAILED")?
            .get(account)
            .cloned())
    }
    fn delete(&self, account: &str) -> Result<(), &'static str> {
        self.entries
            .lock()
            .map_err(|_| "KEYCHAIN_WRITE_FAILED")?
            .remove(account);
        Ok(())
    }
}

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
