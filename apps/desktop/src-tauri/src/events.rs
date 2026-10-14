//! Events pushed to the manager UI. The UI never blocks on long work: it receives these instead.
//!
//! | event               | payload                                  |
//! |---------------------|------------------------------------------|
//! | `operation`         | [`crate::operations::Operation`]          |
//! | `profiles-changed`  | `{ "running": <count> }`                  |
//! | `quit-requested`    | `{ "running": <count>, "unresponsive": <count> }` |
//! | `deep-link`         | `{ "kind": "auth-callback", "outcome": … }` |
//! | `warning`           | `{ "code": "LOW_DISK_SPACE", "free_bytes": … }` |
//! | `account`           | `{ "status": "signed_in" \| "signed_out" \| "expired" \| "failed", … }` |
//! | `sync`              | `{ "profile_id", "job_id", "kind": "upload" \| "restore", "state", "version"?, "portability"? }` |
//! | `team`              | `{ "profile_id", "kind": "phase" \| "requests" \| "handoff_ready" \| "kept_aside" \| "recovery_kept" \| "reconnected", … }` |
//! | `automation`        | `{ "kind": "poll" \| "job", "org_id", "job_id"?, "state"? }` (milestone 10) |
//! | `update`            | [`crate::app_update::UpdateStatus`] (milestone 12) |

use serde_json::Value;
use std::sync::Mutex;

pub const OPERATION: &str = "operation";
pub const PROFILES_CHANGED: &str = "profiles-changed";
pub const QUIT_REQUESTED: &str = "quit-requested";
pub const DEEP_LINK: &str = "deep-link";
pub const WARNING: &str = "warning";
pub const ACCOUNT: &str = "account";
pub const SYNC: &str = "sync";
pub const TEAM: &str = "team";
pub const AUTOMATION: &str = "automation";
pub const UPDATE: &str = "update";

pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: Value);
}

impl<R: tauri::Runtime> EventSink for tauri::AppHandle<R> {
    fn emit_json(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.emit_to("main", event, payload);
    }
}

/// Collects events in memory (tests, and before the app handle exists).
#[derive(Default)]
pub struct RecordingSink {
    pub events: Mutex<Vec<(String, Value)>>,
}

impl EventSink for RecordingSink {
    fn emit_json(&self, event: &str, payload: Value) {
        if let Ok(mut e) = self.events.lock() {
            e.push((event.to_owned(), payload));
        }
    }
}

impl RecordingSink {
    pub fn names(&self) -> Vec<String> {
        self.events
            .lock()
            .map(|e| e.iter().map(|(n, _)| n.clone()).collect())
            .unwrap_or_default()
    }
}
