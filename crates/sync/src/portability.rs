//! What a restored snapshot keeps on this computer (ADR-0028, superseding ADR-0002; measured in the portability
//! matrix):
//!
//! | Where the snapshot was made | Label | Why |
//! |---|---|---|
//! | This device (same enrolled device) | `supported` | Same OS user and key store: sign-ins and site data kept |
//! | Another device, a [`cross_device_sessions`] OS pair | `supported` | The profile's own sessions were carried inside the encrypted snapshot and re-keyed to this computer's browser cookie store on restore (ADR-0028) |
//! | Another device, any other OS pair | `sign_in_required` | Site data restores; sessions are not carried for this pair, so websites may ask for a fresh sign-in |
//! | Newer browser major than installed here, unknown platform or newer snapshot format | `unsupported` | Opening a profile in an older browser is refused (downgrade guard) |
//!
//! Security protections are never removed to make sessions portable: the carried sessions are the profile's own
//! data, moved within one authorized end-to-end-encrypted workspace, re-encrypted under the destination computer's
//! own browser cookie key on arrival and never written anywhere in the clear.
//!
//! The cross-device `supported` set is deliberately narrow: a pair is listed only once the runtime pipeline has
//! MEASURED on real runners of both operating systems that the sessions survive (the pipeline fails on any
//! `supported` label whose cookie did not actually survive). Linux stays `sign_in_required` across devices: its
//! development password store is not machine-bound, so a Linux result is not representative of a shipped device and
//! is never promised. macOS Intel (`macos-x64`) is not yet gated by a runner and so is not promised either.

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

/// Operating systems for which cross-device session carry (ADR-0028) is MEASURED and promised. A pair of these is
/// labelled `supported` across devices; everything else stays `sign_in_required`. Each listed OS has a runtime-
/// pipeline runner that proves, on every run, that a session sealed on a source OS really opens still-signed-in
/// here (the pipeline fails on any dishonest `supported` label). Keep this list honest: do not add an OS until a
/// runner measures it. Linux and `macos-x64` are intentionally absent (see the module docs).
pub const SESSION_CARRY_PLATFORMS: &[&str] = &["windows-x64", "macos-arm64"];

/// Whether a workspace profile's stored sessions are carried, and promised, from `source` to `dest` across devices.
pub fn cross_device_sessions(source: &str, dest: &str) -> bool {
    SESSION_CARRY_PLATFORMS.contains(&source) && SESSION_CARRY_PLATFORMS.contains(&dest)
}

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
    } else if cross_device_sessions(snapshot_platform, here.platform) {
        // The profile's own sessions were carried inside the encrypted snapshot and are re-keyed to this computer's
        // browser cookie store on restore (ADR-0028). Promised only for measured OS pairs.
        Verdict {
            portability: Portability::Supported,
            reason: "cross_device_sessions",
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
        let v = |p, b, d| classify(p, b, 1, d, &HERE); // HERE is windows-x64, device dev_A
        assert_eq!(
            v("windows-x64", "155.0.8059.39", Some("dev_A")).portability,
            Portability::Supported,
            "same device"
        );
        // Another Windows PC: sessions are carried and re-keyed (ADR-0028), a measured pair.
        assert_eq!(
            v("windows-x64", "154.0.1.2", Some("dev_B")),
            Verdict {
                portability: Portability::Supported,
                reason: "cross_device_sessions"
            }
        );
        // A Mac's profile restored on this Windows PC: a measured cross-OS pair, so sessions carry.
        assert_eq!(
            v("macos-arm64", "155.0.1.2", Some("dev_A")),
            Verdict {
                portability: Portability::Supported,
                reason: "cross_device_sessions"
            },
            "a device id never matches across platforms, but the pair is promised"
        );
        // Linux is development-only and never promised across devices.
        assert_eq!(
            v("linux-x64", "155.0.1.2", None).portability,
            Portability::SignInRequired
        );
        // macOS Intel has no runner gating it yet, so it is not promised either.
        assert_eq!(
            v("macos-x64", "155.0.1.2", Some("dev_C")).portability,
            Portability::SignInRequired,
            "macos-x64 is not in the measured session-carry set"
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

    #[test]
    fn cross_device_only_promises_measured_pairs() {
        // The promised set and both directions across it.
        assert!(cross_device_sessions("windows-x64", "macos-arm64"));
        assert!(cross_device_sessions("macos-arm64", "windows-x64"));
        assert!(cross_device_sessions("windows-x64", "windows-x64"));
        assert!(cross_device_sessions("macos-arm64", "macos-arm64"));
        // Anything touching Linux or macOS Intel is not promised across devices.
        for other in ["linux-x64", "macos-x64", "solaris-sparc"] {
            assert!(!cross_device_sessions(other, "windows-x64"));
            assert!(!cross_device_sessions("macos-arm64", other));
        }

        // A snapshot from a promised OS restored onto an unpromised one (here: Linux) stays sign-in required.
        let here_linux = Here {
            platform: "linux-x64",
            device_id: Some("dev_L"),
            browser_version: Some("155.0.8059.39"),
        };
        assert_eq!(
            classify(
                "windows-x64",
                "155.0.8059.39",
                1,
                Some("dev_W"),
                &here_linux
            )
            .portability,
            Portability::SignInRequired
        );
    }
}
