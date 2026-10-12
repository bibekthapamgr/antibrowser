//! Keeps the profile process table consistent with reality, whether or not the manager UI is open.
//!
//! - Every started browser is recorded with (pid, OS start time, executable) in SQLite before the UI is told.
//! - On manager start, recorded processes are re-checked: still-running ones are adopted (shown as "opened before
//!   the manager restarted"), dead ones and reused pids are cleared. An unrelated process is never signalled.
//! - A background monitor reaps children and clears exited processes so the list never shows ghosts.
//! - Stopping asks the browser to exit cleanly first and only force-terminates after a timeout.

use pb_runtime::{ProcessInspector, ProfileId, Spawned};
use pb_storage::LocalStore;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(10);

struct Tracked {
    pid: u32,
    start_time: Option<u64>,
    exe: Option<String>,
    child: Option<Child>,
    adopted: bool,
    stopping: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunningProfile {
    pub profile_id: String,
    pub pid: u32,
    /// True if the process was already running when this manager instance started.
    pub adopted: bool,
    pub stopping: bool,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct ReconcileReport {
    pub adopted: u32,
    pub cleared: u32,
}

pub struct Supervisor {
    tracked: Mutex<HashMap<ProfileId, Tracked>>,
    inspector: Arc<dyn ProcessInspector>,
}

impl Supervisor {
    pub fn new(inspector: Arc<dyn ProcessInspector>) -> Self {
        Self {
            tracked: Mutex::new(HashMap::new()),
            inspector,
        }
    }

    pub fn inspector(&self) -> &Arc<dyn ProcessInspector> {
        &self.inspector
    }

    /// Called once at startup (and after a crash) to rebuild state from the local store.
    pub fn reconcile_on_startup(&self, store: &LocalStore) -> ReconcileReport {
        let mut report = ReconcileReport::default();
        let Ok(records) = store.list_processes() else {
            return report;
        };
        let Ok(mut tracked) = self.tracked.lock() else {
            return report;
        };
        for rec in records {
            if self
                .inspector
                .is_same(rec.pid, rec.process_start_time, rec.executable.as_deref())
            {
                tracked.insert(
                    rec.profile_id,
                    Tracked {
                        pid: rec.pid,
                        start_time: rec.process_start_time,
                        exe: rec.executable,
                        child: None,
                        adopted: true,
                        stopping: false,
                    },
                );
                report.adopted += 1;
            } else {
                let _ = store.clear_process(&rec.profile_id);
                report.cleared += 1;
            }
        }
        report
    }

    pub fn is_running(&self, id: &ProfileId) -> bool {
        self.tracked
            .lock()
            .map(|t| t.contains_key(id))
            .unwrap_or(false)
    }

    pub fn register(
        &self,
        store: &LocalStore,
        id: &ProfileId,
        spawned: Spawned,
        exe: &str,
    ) -> Result<(), pb_storage::StoreError> {
        let start_time = self.inspector.inspect(spawned.pid).map(|i| i.start_time);
        store.record_process(id, spawned.pid, start_time, Some(exe))?;
        if let Ok(mut tracked) = self.tracked.lock() {
            tracked.insert(
                id.clone(),
                Tracked {
                    pid: spawned.pid,
                    start_time,
                    exe: Some(exe.to_owned()),
                    child: spawned.child,
                    adopted: false,
                    stopping: false,
                },
            );
        }
        Ok(())
    }

    /// Reaps exited children and clears exited/reused processes. Returns profiles that stopped.
    pub fn poll(&self, store: &LocalStore) -> Vec<ProfileId> {
        let Ok(mut tracked) = self.tracked.lock() else {
            return vec![];
        };
        let mut exited = vec![];
        for (id, t) in tracked.iter_mut() {
            let gone = match t.child.as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                None => !self
                    .inspector
                    .is_same(t.pid, t.start_time, t.exe.as_deref()),
            };
            if gone {
                exited.push(id.clone());
            }
        }
        for id in &exited {
            tracked.remove(id);
            let _ = store.clear_process(id);
        }
        exited
    }

    pub fn running(&self) -> Vec<RunningProfile> {
        let Ok(tracked) = self.tracked.lock() else {
            return vec![];
        };
        let mut out: Vec<RunningProfile> = tracked
            .iter()
            .map(|(id, t)| RunningProfile {
                profile_id: id.to_string(),
                pid: t.pid,
                adopted: t.adopted,
                stopping: t.stopping,
            })
            .collect();
        out.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
        out
    }

    pub fn running_count(&self) -> usize {
        self.tracked.lock().map(|t| t.len()).unwrap_or(0)
    }

    pub fn running_ids(&self) -> Vec<ProfileId> {
        self.tracked
            .lock()
            .map(|t| t.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Total resident memory of tracked browser main processes (diagnostics; excludes the manager).
    pub fn browser_memory_bytes(&self) -> u64 {
        let pids: Vec<u32> = self
            .tracked
            .lock()
            .map(|t| t.values().map(|x| x.pid).collect())
            .unwrap_or_default();
        pids.iter()
            .filter_map(|p| self.inspector.inspect(*p))
            .map(|i| i.memory_bytes)
            .sum()
    }

    /// Graceful stop with a forced fallback. Blocking: call from a worker thread.
    pub fn stop(&self, store: &LocalStore, id: &ProfileId, timeout: Duration) -> StopOutcome {
        let target = {
            let Ok(mut tracked) = self.tracked.lock() else {
                return StopOutcome::NotRunning;
            };
            let Some(t) = tracked.get_mut(id) else {
                return StopOutcome::NotRunning;
            };
            if !self
                .inspector
                .is_same(t.pid, t.start_time, t.exe.as_deref())
                && t.child.is_none()
            {
                None // already gone; never signal a pid that may now belong to someone else
            } else {
                t.stopping = true;
                Some(t.pid)
            }
        };
        let Some(pid) = target else {
            self.poll(store);
            return StopOutcome::Stopped;
        };

        self.inspector.request_exit(pid);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            self.poll(store);
            if !self.is_running(id) {
                return StopOutcome::Stopped;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        // Timed out: force, but only if it is still the same process.
        let still_same = self
            .tracked
            .lock()
            .ok()
            .and_then(|t| {
                t.get(id).map(|t| {
                    self.inspector
                        .is_same(t.pid, t.start_time, t.exe.as_deref())
                })
            })
            .unwrap_or(false);
        if still_same {
            self.inspector.kill(pid);
        }
        for _ in 0..20 {
            self.poll(store);
            if !self.is_running(id) {
                return StopOutcome::Forced;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        StopOutcome::StillRunning
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopOutcome {
    NotRunning,
    Stopped,
    Forced,
    StillRunning,
}

pub mod fake {
    //! An in-memory process table for unit and integration tests (no real browsers needed).
    use pb_runtime::{ProcessInfo, ProcessInspector};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeProcesses {
        pub table: Mutex<HashMap<u32, ProcessInfo>>,
        /// pids that ignore graceful exit requests
        pub stubborn: Mutex<Vec<u32>>,
        pub signals: Mutex<Vec<(u32, &'static str)>>,
    }

    impl FakeProcesses {
        pub fn add(&self, pid: u32, start_time: u64, exe: &str) {
            if let Ok(mut t) = self.table.lock() {
                t.insert(
                    pid,
                    ProcessInfo {
                        pid,
                        start_time,
                        exe: Some(exe.into()),
                        memory_bytes: 50_000_000,
                    },
                );
            }
        }
        pub fn remove(&self, pid: u32) {
            if let Ok(mut t) = self.table.lock() {
                t.remove(&pid);
            }
        }
    }

    impl ProcessInspector for FakeProcesses {
        fn inspect(&self, pid: u32) -> Option<ProcessInfo> {
            self.table.lock().ok()?.get(&pid).cloned()
        }
        fn request_exit(&self, pid: u32) -> bool {
            if let Ok(mut s) = self.signals.lock() {
                s.push((pid, "exit"));
            }
            if !self
                .stubborn
                .lock()
                .map(|s| s.contains(&pid))
                .unwrap_or(false)
            {
                self.remove(pid);
            }
            true
        }
        fn kill(&self, pid: u32) -> bool {
            if let Ok(mut s) = self.signals.lock() {
                s.push((pid, "kill"));
            }
            self.remove(pid);
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeProcesses;
    use super::*;
    use pb_storage::NewProfile;

    fn setup() -> (
        tempfile::TempDir,
        LocalStore,
        Arc<FakeProcesses>,
        Supervisor,
        ProfileId,
    ) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store =
            LocalStore::open(&dir.path().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
        let ws = store
            .create_workspace("W")
            .unwrap_or_else(|e| panic!("{e}"));
        let id = ProfileId::generate().unwrap_or_else(|e| panic!("{e}"));
        store
            .insert_profile(NewProfile {
                id: &id,
                workspace_id: Some(&ws.id),
                name: "P",
                client_label: None,
                folder_label: None,
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let procs = Arc::new(FakeProcesses::default());
        let sup = Supervisor::new(procs.clone());
        (dir, store, procs, sup, id)
    }

    #[test]
    fn adopts_live_processes_and_clears_dead_or_reused_pids() {
        let (_d, store, procs, sup, id) = setup();
        procs.add(100, 1000, "/rt/chromium");
        store
            .record_process(&id, 100, Some(1000), Some("/rt/chromium"))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            sup.reconcile_on_startup(&store),
            ReconcileReport {
                adopted: 1,
                cleared: 0
            }
        );
        assert!(sup.running()[0].adopted);

        // Manager restarts again, but pid 100 now belongs to a different program started later.
        let sup2 = Supervisor::new(procs.clone());
        procs.add(100, 5000, "/usr/bin/unrelated");
        assert_eq!(
            sup2.reconcile_on_startup(&store),
            ReconcileReport {
                adopted: 0,
                cleared: 1
            }
        );
        assert_eq!(store.list_processes().map(|p| p.len()).unwrap_or(9), 0);
        assert!(
            procs.signals.lock().map(|s| s.is_empty()).unwrap_or(false),
            "unrelated process never signalled"
        );
    }

    #[test]
    fn monitor_clears_exited_processes() {
        let (_d, store, procs, sup, id) = setup();
        procs.add(200, 1000, "/rt/chromium");
        sup.register(
            &store,
            &id,
            Spawned {
                pid: 200,
                child: None,
            },
            "/rt/chromium",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(sup.running_count(), 1);
        procs.remove(200);
        assert_eq!(sup.poll(&store), vec![id.clone()]);
        assert_eq!(sup.running_count(), 0);
        assert!(
            store
                .list_processes()
                .map(|p| p.is_empty())
                .unwrap_or(false)
        );
    }

    #[test]
    fn stop_is_graceful_first_then_forced() {
        let (_d, store, procs, sup, id) = setup();
        procs.add(300, 1000, "/rt/chromium");
        sup.register(
            &store,
            &id,
            Spawned {
                pid: 300,
                child: None,
            },
            "/rt/chromium",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            sup.stop(&store, &id, Duration::from_millis(300)),
            StopOutcome::Stopped
        );
        assert_eq!(
            procs.signals.lock().map(|s| s.clone()).unwrap_or_default(),
            vec![(300, "exit")]
        );

        procs.add(301, 1000, "/rt/chromium");
        procs
            .stubborn
            .lock()
            .unwrap_or_else(|e| panic!("{e}"))
            .push(301);
        sup.register(
            &store,
            &id,
            Spawned {
                pid: 301,
                child: None,
            },
            "/rt/chromium",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            sup.stop(&store, &id, Duration::from_millis(300)),
            StopOutcome::Forced
        );
        assert!(
            procs
                .signals
                .lock()
                .map(|s| s.contains(&(301, "kill")))
                .unwrap_or(false)
        );
        assert_eq!(
            sup.stop(&store, &id, Duration::from_millis(10)),
            StopOutcome::NotRunning
        );
    }
}
