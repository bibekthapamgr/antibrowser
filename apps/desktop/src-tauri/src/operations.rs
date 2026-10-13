//! Long-running work (launch, stop, close-all, runtime verification) is tracked as an operation: the IPC call
//! returns an `operation_id` at once and progress/status arrive as `operation` events.

use crate::events::{EventSink, OPERATION};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    LaunchProfile,
    StopProfile,
    CloseAll,
    VerifyRuntime,
    InstallRuntime,
    RecoverProfile,
    BackupProfile,
    ImportProfiles,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Operation {
    pub operation_id: String,
    pub kind: OpKind,
    pub status: OpStatus,
    /// 0.0-1.0 when measurable.
    pub progress: Option<f32>,
    pub target: Option<String>,
    pub error_code: Option<&'static str>,
    pub message: Option<&'static str>,
}

#[derive(Serialize)]
pub struct Started {
    pub operation_id: String,
}

pub struct Operations {
    next: AtomicU64,
    ops: Mutex<HashMap<String, Operation>>,
    events: Arc<dyn EventSink>,
}

impl Operations {
    pub fn new(events: Arc<dyn EventSink>) -> Self {
        Self {
            next: AtomicU64::new(1),
            ops: Mutex::new(HashMap::new()),
            events,
        }
    }

    pub fn start(&self, kind: OpKind, target: Option<String>) -> String {
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        let id = format!("op_{n}");
        let op = Operation {
            operation_id: id.clone(),
            kind,
            status: OpStatus::Running,
            progress: None,
            target,
            error_code: None,
            message: None,
        };
        self.store(op);
        id
    }

    pub fn progress(&self, id: &str, value: f32) {
        self.update(id, |op| op.progress = Some(value.clamp(0.0, 1.0)));
    }

    /// Marks a running operation as succeeded (no effect once it has finished).
    pub fn succeed(&self, id: &str) {
        self.update(id, |op| {
            if op.status == OpStatus::Running {
                op.status = OpStatus::Succeeded;
                op.progress = Some(1.0);
            }
        });
    }

    /// Marks a running operation as failed (no effect once it has finished).
    pub fn fail(&self, id: &str, code: &'static str, message: &'static str) {
        self.update(id, |op| {
            if op.status == OpStatus::Running {
                op.status = OpStatus::Failed;
                op.error_code = Some(code);
                op.message = Some(message);
            }
        });
    }

    pub fn get(&self, id: &str) -> Option<Operation> {
        self.ops.lock().ok()?.get(id).cloned()
    }

    /// Most recent first, bounded.
    pub fn list(&self) -> Vec<Operation> {
        let Ok(ops) = self.ops.lock() else {
            return vec![];
        };
        let mut all: Vec<Operation> = ops.values().cloned().collect();
        all.sort_by_key(|o| {
            std::cmp::Reverse(
                o.operation_id
                    .trim_start_matches("op_")
                    .parse::<u64>()
                    .unwrap_or(0),
            )
        });
        all.truncate(50);
        all
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Operation)) {
        let updated = {
            let Ok(mut ops) = self.ops.lock() else { return };
            let Some(op) = ops.get_mut(id) else { return };
            f(op);
            op.clone()
        };
        self.emit(&updated);
    }

    fn store(&self, op: Operation) {
        if let Ok(mut ops) = self.ops.lock() {
            // Keep memory bounded: drop the oldest finished operations.
            if ops.len() >= 200 {
                let mut finished: Vec<(u64, String)> = ops
                    .values()
                    .filter(|o| o.status != OpStatus::Running)
                    .map(|o| {
                        (
                            o.operation_id
                                .trim_start_matches("op_")
                                .parse()
                                .unwrap_or(0),
                            o.operation_id.clone(),
                        )
                    })
                    .collect();
                finished.sort();
                for (_, id) in finished.into_iter().take(100) {
                    ops.remove(&id);
                }
            }
            ops.insert(op.operation_id.clone(), op.clone());
        }
        self.emit(&op);
    }

    fn emit(&self, op: &Operation) {
        self.events
            .emit_json(OPERATION, serde_json::to_value(op).unwrap_or_default());
    }

    /// Test helper: waits until an operation finishes.
    pub fn wait(&self, id: &str, timeout: std::time::Duration) -> Option<Operation> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let op = self.get(id)?;
            if op.status != OpStatus::Running || std::time::Instant::now() > deadline {
                return Some(op);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
