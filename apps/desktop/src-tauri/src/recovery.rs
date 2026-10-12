//! Crash detection and scrubbed local crash reports.
//!
//! - A session marker is written at start and removed on clean exit. If it is still present at the next start and
//!   its process is gone, the previous session ended abnormally and the UI shows the crash recovery prompt.
//! - A panic hook writes a crash report locally. Reports are scrubbed of the home directory, user name and
//!   token-like strings. Nothing is uploaded: sending reports is opt-in (`privacy.crash_reports`) and no upload
//!   service exists until milestone 13.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MARKER: &str = "session.json";
const REPORTS: &str = "crash-reports";
const MAX_REPORTS: usize = 20;

#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    pid: u32,
    started_at_unix: u64,
    version: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub previous_session_crashed: bool,
    pub previous_version: Option<String>,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Checks the previous marker and writes a new one. `is_alive(pid)` lets the caller supply process inspection.
pub fn begin_session(
    data_dir: &Path,
    version: &str,
    is_alive: impl Fn(u32) -> bool,
) -> SessionInfo {
    let path = data_dir.join(MARKER);
    let mut info = SessionInfo::default();
    if let Ok(bytes) = std::fs::read(&path) {
        match serde_json::from_slice::<Marker>(&bytes) {
            Ok(m) if m.pid != std::process::id() && !is_alive(m.pid) => {
                info.previous_session_crashed = true;
                info.previous_version = Some(m.version);
            }
            Ok(_) => {}
            Err(_) => info.previous_session_crashed = true, // torn write during a crash
        }
    }
    let marker = Marker {
        pid: std::process::id(),
        started_at_unix: now_unix(),
        version: version.to_owned(),
    };
    if let Ok(json) = serde_json::to_vec(&marker) {
        let tmp = data_dir.join("session.json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, &path);
        }
    }
    info
}

pub fn end_session(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(MARKER));
}

/// Replaces personal or secret-looking content.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_owned();
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(var)
            && home.len() > 1
        {
            out = out.replace(&home, "~");
        }
    }
    for var in ["USER", "USERNAME", "LOGNAME"] {
        if let Ok(user) = std::env::var(var)
            && user.len() > 2
        {
            out = out.replace(&user, "<user>");
        }
    }
    // Long opaque tokens (hex/base64/JWT-like) are removed.
    out.split_inclusive(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '(' | ')' | '=' | ':')
    })
    .map(|piece| {
        let core = piece.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '(' | ')' | '=' | ':')
        });
        let tail = &piece[core.len()..];
        let tokenish = core.len() >= 32
            && core
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/'))
            && core.chars().any(|c| c.is_ascii_digit());
        if tokenish {
            format!("[redacted]{tail}")
        } else {
            piece.to_owned()
        }
    })
    .collect()
}

#[derive(Serialize)]
struct CrashReport<'a> {
    kind: &'a str,
    version: &'a str,
    os: &'a str,
    arch: &'a str,
    at_unix: u64,
    message: String,
    location: Option<String>,
}

pub fn install_panic_hook(data_dir: PathBuf, version: &'static str) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let report = CrashReport {
            kind: "panic",
            version,
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            at_unix: now_unix(),
            message: scrub(&message),
            location: info
                .location()
                .map(|l| scrub(&format!("{}:{}", l.file(), l.line()))),
        };
        write_report(&data_dir, &report);
        previous(info);
    }));
}

fn write_report<T: Serialize>(data_dir: &Path, report: &T) {
    let dir = data_dir.join(REPORTS);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_vec_pretty(report) {
        let _ = std::fs::write(
            dir.join(format!("crash-{}-{}.json", now_unix(), std::process::id())),
            json,
        );
    }
    // Keep only the newest reports.
    let mut files = list_reports(data_dir);
    if files.len() > MAX_REPORTS {
        files.sort();
        for old in &files[..files.len() - MAX_REPORTS] {
            let _ = std::fs::remove_file(old);
        }
    }
}

pub fn list_reports(data_dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(data_dir.join(REPORTS))
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_an_unclean_previous_session() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let first = begin_session(dir.path(), "0.2.0", |_| true);
        assert!(!first.previous_session_crashed);
        // Simulate a previous process that died without end_session.
        std::fs::write(
            dir.path().join(MARKER),
            r#"{"pid":999999,"started_at_unix":1,"version":"0.1.0"}"#,
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let after_crash = begin_session(dir.path(), "0.2.0", |_| false);
        assert!(after_crash.previous_session_crashed);
        assert_eq!(after_crash.previous_version.as_deref(), Some("0.1.0"));
        end_session(dir.path());
        assert!(
            !begin_session(dir.path(), "0.2.0", |_| false).previous_session_crashed,
            "clean exit is not a crash"
        );
    }

    #[test]
    fn scrubs_tokens_and_home() {
        let s = scrub(
            "failed with token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef012345 near x",
        );
        assert!(!s.contains("eyJhbGci"), "{s}");
        assert!(s.contains("[redacted]"));
        assert!(s.contains("near x"));
        if let Ok(home) = std::env::var("HOME")
            && home.len() > 1
        {
            assert!(!scrub(&format!("{home}/Library/x")).contains(&home));
        }
    }
}
