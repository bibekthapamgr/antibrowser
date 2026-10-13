//! What a restored snapshot keeps on this computer (ADR-0002, measured in the portability matrix):
//!
//! | Where the snapshot was made | Label | Why |
//! |---|---|---|
//! | This device (same enrolled device) | `supported` | Same OS user and key store: sign-ins and site data kept |
//! | Another device, any OS | `sign_in_required` | Site data restores; cookies are protected by OS-bound keys (DPAPI, Keychain) that do not travel. Linux → Linux kept cookies in tests, but only because the development key store is not machine-bound, so it is not promised |
//! | Newer browser major than installed here, unknown platform or newer snapshot format | `unsupported` | Opening a profile in an older browser is refused (downgrade guard) |
//!
//! Security protections are never removed to make sessions portable.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Portability {
    Supported,
    SignInRequired,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub portability: Portability,
    /// Machine-readable reason (`same_device`, `other_device`, `RUNTIME_TOO_OLD`, `NO_RUNTIME`, …).
    pub reason: &'static str,
}

pub const PLATFORMS: &[&str] = &["windows-x64", "macos-arm64", "macos-x64", "linux-x64"];
/// Snapshot format versions this build can open.
pub const MAX_SCHEMA_VERSION: u32 = 1;

/// The browser's major version (`155.0.8059.39` → 155).
pub fn major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

pub struct Here<'a> {
    pub platform: &'a str,
    pub device_id: Option<&'a str>,
    /// Installed browser version (`None`: no browser installed yet).
    pub browser_version: Option<&'a str>,
}

pub fn classify(
    snapshot_platform: &str,
    snapshot_browser: &str,
    snapshot_schema: u32,
    snapshot_device: Option<&str>,
    here: &Here<'_>,
) -> Verdict {
    let unsupported = |reason| Verdict {
        portability: Portability::Unsupported,
        reason,
    };
    if !PLATFORMS.contains(&snapshot_platform) {
        return unsupported("UNKNOWN_PLATFORM");
    }
    if snapshot_schema == 0 || snapshot_schema > MAX_SCHEMA_VERSION {
        return unsupported("SNAPSHOT_FORMAT_TOO_NEW");
    }
    let Some(installed) = here.browser_version else {
        return unsupported("NO_RUNTIME");
    };
    match (major(snapshot_browser), major(installed)) {
        (Some(made), Some(have)) if made > have => return unsupported("RUNTIME_TOO_OLD"),
        (Some(_), Some(_)) => {}
        _ => return unsupported("UNKNOWN_BROWSER_VERSION"),
    }
    let same_device = matches!((snapshot_device, here.device_id), (Some(a), Some(b)) if a == b)
        && snapshot_platform == here.platform;
    if same_device {
        Verdict {
            portability: Portability::Supported,
            reason: "same_device",
        }
    } else {
        Verdict {
            portability: Portability::SignInRequired,
            reason: "other_device",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HERE: Here<'static> = Here {
        platform: "windows-x64",
        device_id: Some("dev_A"),
        browser_version: Some("155.0.8059.39"),
    };

    #[test]
    fn labels_follow_the_measured_matrix() {
        let v = |p, b, d| classify(p, b, 1, d, &HERE);
        assert_eq!(
            v("windows-x64", "155.0.8059.39", Some("dev_A")).portability,
            Portability::Supported
        );
        assert_eq!(
            v("windows-x64", "154.0.1.2", Some("dev_B")).portability,
            Portability::SignInRequired
        );
        assert_eq!(
            v("macos-arm64", "155.0.1.2", Some("dev_A")).portability,
            Portability::SignInRequired,
            "a device id never matches across platforms"
        );
        assert_eq!(
            v("linux-x64", "155.0.1.2", None).portability,
            Portability::SignInRequired
        );
        assert_eq!(
            v("windows-x64", "156.0.1.2", Some("dev_A")),
            Verdict {
                portability: Portability::Unsupported,
                reason: "RUNTIME_TOO_OLD"
            }
        );
        assert_eq!(
            v("solaris-sparc", "155.0", Some("dev_A")).reason,
            "UNKNOWN_PLATFORM"
        );
        assert_eq!(
            classify("windows-x64", "155.0", 2, None, &HERE).reason,
            "SNAPSHOT_FORMAT_TOO_NEW"
        );
        let bare = Here {
            browser_version: None,
            ..HERE
        };
        assert_eq!(
            classify("windows-x64", "155.0", 1, Some("dev_A"), &bare).reason,
            "NO_RUNTIME"
        );
    }
}
