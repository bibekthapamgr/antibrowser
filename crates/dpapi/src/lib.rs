//! Windows Data Protection API (DPAPI) for the browser's cookie key (ADR-0028).
//!
//! Chromium on Windows keeps each profile's cookie key in `Local State`, wrapped with DPAPI for the signed-in Windows
//! user. Carrying a shared profile's sign-ins to another computer means unwrapping that key here (as the same user
//! the browser runs as) and wrapping the destination key for the destination user. Nothing else in the workspace
//! calls Win32 for this; on other systems both functions answer `None`.

#[cfg(windows)]
mod win;

/// Wraps `data` for the current Windows user (`CryptProtectData`). `None` on failure or on other systems.
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    #[cfg(windows)]
    {
        win::protect(data)
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        None
    }
}

/// Unwraps `data` that was wrapped for the current Windows user (`CryptUnprotectData`). `None` on failure or on
/// other systems.
pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    #[cfg(windows)]
    {
        win::unprotect(data)
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        None
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    #[test]
    fn other_systems_answer_none() {
        assert_eq!(super::protect(b"k"), None);
        assert_eq!(super::unprotect(b"k"), None);
    }

    #[cfg(windows)]
    #[test]
    fn round_trip_for_this_user() {
        let wrapped = super::protect(b"cookie key").unwrap_or_default();
        assert!(!wrapped.is_empty());
        assert_eq!(
            super::unprotect(&wrapped).as_deref(),
            Some(&b"cookie key"[..])
        );
    }
}
