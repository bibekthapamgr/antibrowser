use super::fake::FakeProcesses;
use super::*;
use pb_storage::NewProfile;

struct Fx {
    _dir: tempfile::TempDir,
    store: LocalStore,
    procs: Arc<FakeProcesses>,
    sup: Option<Supervisor>,
    root: ProfilesRoot,
    id: ProfileId,
}

impl Fx {
    fn sup(&self) -> &Supervisor {
        self.sup.as_ref().unwrap_or_else(|| panic!("supervisor"))
    }
}

fn setup() -> Fx {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let store = LocalStore::open(&dir.path().join("local.db")).unwrap_or_else(|e| panic!("{e}"));
    let ws = store
        .create_workspace("W")
        .unwrap_or_else(|e| panic!("{e}"));
    let id = ProfileId::generate().unwrap_or_else(|e| panic!("{e}"));
    store
        .insert_profile(NewProfile::basic(
            id.clone(),
            Some(ws.id.clone()),
            "P",
            None,
        ))
        .unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(dir.path().join("profiles")).unwrap_or_else(|e| panic!("{e}"));
    let root = ProfilesRoot::open(&dir.path().join("profiles")).unwrap_or_else(|e| panic!("{e}"));
    root.ensure(&id).unwrap_or_else(|e| panic!("{e}"));
    let procs = Arc::new(FakeProcesses::default());
    let sup = Some(Supervisor::new(procs.clone()));
    Fx {
        _dir: dir,
        store,
        procs,
        sup,
        root,
        id,
    }
}

fn lock(fx: &Fx) -> ProfileLock {
    ProfileLock::try_acquire(&fx.root.dirs(&fx.id).root)
        .unwrap_or_else(|e| panic!("{e}"))
        .unwrap_or_else(|| panic!("lock busy"))
}

fn flag(fx: &Fx) -> String {
    procs::user_data_flag(&fx.root.dirs(&fx.id).user_data)
        .to_string_lossy()
        .into_owned()
}

/// Simulates a browser: main process with the profile flag plus one renderer.
fn spawn(fx: &Fx, pid: u32) {
    fx.procs.add_full(
        pid,
        Some(1),
        1000,
        "/rt/chrome",
        vec!["chrome".into(), flag(fx)],
    );
    fx.procs.add_full(
        pid + 1,
        Some(pid),
        1000,
        "/rt/chrome",
        vec!["chrome".into(), "--type=renderer".into()],
    );
    fx.sup()
        .begin_start(
            &fx.id,
            lock(fx),
            fx.root.dirs(&fx.id).user_data,
            Some("155.0.0.1".into()),
            "op_1".into(),
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    fx.sup()
        .attach_spawn(
            &fx.store,
            &fx.id,
            Spawned { pid, child: None },
            Path::new("/rt/chrome"),
        )
        .unwrap_or_else(|e| panic!("{e}"));
}

fn write_exit(fx: &Fx, exit_type: &str) {
    let path = prefs::preferences_path(&fx.root.dirs(&fx.id).user_data);
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("/")))
        .unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        path,
        format!(r#"{{"profile":{{"exit_type":"{exit_type}"}}}}"#),
    )
    .unwrap_or_else(|e| panic!("{e}"));
}

fn state(fx: &Fx) -> RunState {
    fx.store
        .get_profile(&fx.id)
        .ok()
        .flatten()
        .map(|p| p.state)
        .unwrap_or(RunState::Stopped)
}

#[test]
fn ready_window_and_clean_exit() {
    let fx = setup();
    spawn(&fx, 100);
    assert_eq!(state(&fx), RunState::Starting);
    let ev = fx.sup().poll(&fx.store);
    assert!(matches!(ev.as_slice(), [PollEvent::Ready { start_op: Some(op), .. }] if op == "op_1"));
    let s = fx.sup().status(&fx.id).unwrap_or_else(|| panic!("tracked"));
    assert!(s.ready && s.window_open && s.helpers == 1);
    assert_eq!(state(&fx), RunState::Running);
    // A second launch request is answered with the existing operation.
    assert_eq!(fx.sup().active_start(&fx.id), Some(Ok(Some("op_1".into()))));

    write_exit(&fx, "Normal");
    fx.procs.remove(100);
    let ev = fx.sup().poll(&fx.store);
    assert!(matches!(ev.as_slice(), [PollEvent::Finished(f)] if f.outcome == RunOutcome::Clean));
    assert_eq!(state(&fx), RunState::Stopped);
    assert!(
        ProfileLock::try_acquire(&fx.root.dirs(&fx.id).root)
            .ok()
            .flatten()
            .is_some(),
        "lock released after the run"
    );
}

#[test]
fn crash_is_classified_from_chromiums_exit_record() {
    let fx = setup();
    spawn(&fx, 200);
    fx.sup().poll(&fx.store);
    write_exit(&fx, "Crashed");
    fx.procs.remove(200);
    let ev = fx.sup().poll(&fx.store);
    assert!(matches!(ev.as_slice(), [PollEvent::Finished(f)] if f.state == RunState::Crashed));
    let p = fx.store.get_profile(&fx.id).ok().flatten();
    assert_eq!(p.as_ref().map(|p| p.crash_count), Some(1));
    assert_eq!(
        p.and_then(|p| p.last_error).as_deref(),
        Some("EXITED_EARLY")
    );
}

#[test]
fn waits_for_helpers_before_ending_the_run() {
    let fx = setup();
    spawn(&fx, 300);
    fx.sup().poll(&fx.store);
    write_exit(&fx, "Normal");
    // Main exits but the helper (a writer) is still alive: the run is not over yet.
    if let Ok(mut t) = fx.procs.table.lock() {
        t.remove(&300);
    }
    assert!(fx.sup().poll(&fx.store).is_empty());
    assert!(fx.sup().is_tracked(&fx.id));
    fx.procs.remove(301);
    assert_eq!(fx.sup().poll(&fx.store).len(), 1);
    assert!(!fx.sup().is_tracked(&fx.id));
}

#[test]
fn graceful_stop_then_explicit_force_only_kills_the_tree() {
    let fx = setup();
    spawn(&fx, 400);
    fx.procs.add(999, 1000, "/rt/chrome"); // another profile's browser: must never be touched
    fx.procs
        .stubborn
        .lock()
        .unwrap_or_else(|e| panic!("{e}"))
        .push(400);
    fx.sup().poll(&fx.store);
    assert_eq!(fx.sup().request_stop(&fx.store, &fx.id), Ok(true));
    assert_eq!(state(&fx), RunState::Stopping);
    assert!(
        fx.sup().poll(&fx.store).is_empty(),
        "still running after the request"
    );
    fx.sup().mark_stop_timed_out(&fx.id);
    assert!(fx.sup().status(&fx.id).is_some_and(|s| s.force_available));
    fx.sup()
        .force_stop(&fx.store, &fx.id)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let ev = fx.sup().poll(&fx.store);
    assert!(matches!(ev.as_slice(), [PollEvent::Finished(f)] if f.outcome == RunOutcome::Forced));
    assert_eq!(state(&fx), RunState::Stopped);
    let signals = fx
        .procs
        .signals
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    assert!(signals.contains(&(400, "kill")) && signals.contains(&(401, "kill")));
    assert!(!signals.iter().any(|(p, _)| *p == 999));
    assert!(fx.procs.contains(999));
}

#[test]
fn restart_adopts_verified_runs_and_closes_vanished_ones() {
    let mut fx = setup();
    spawn(&fx, 500);
    fx.sup().poll(&fx.store);
    // The manager quits (supervisor dropped, lock released) while the browser keeps running.
    fx.sup = None;
    let sup = Supervisor::new(fx.procs.clone());
    let report = sup.reconcile_on_startup(&fx.store, &fx.root, &[PathBuf::from("/rt/chrome")]);
    assert_eq!(report.adopted, 1);
    assert!(sup.status(&fx.id).is_some_and(|s| s.adopted));
    drop(sup);

    // Next restart: the pid now belongs to an unrelated program started later.
    fx.procs.remove(500);
    fx.procs.add(500, 9999, "/usr/bin/other");
    let sup = Supervisor::new(fx.procs.clone());
    let report = sup.reconcile_on_startup(&fx.store, &fx.root, &[PathBuf::from("/rt/chrome")]);
    assert_eq!((report.adopted, report.cleared), (0, 1));
    assert!(
        fx.store
            .active_runs()
            .map(|r| r.is_empty())
            .unwrap_or(false)
    );
    assert!(
        fx.procs
            .signals
            .lock()
            .map(|s| s.is_empty())
            .unwrap_or(false),
        "unrelated process never signalled"
    );
}

#[test]
fn restart_adopts_an_unrecorded_browser_only_if_it_is_our_runtime() {
    let fx = setup();
    fx.procs.add_full(
        600,
        Some(1),
        1000,
        "/elsewhere/chrome",
        vec!["chrome".into(), flag(&fx)],
    );
    let report = fx
        .sup()
        .reconcile_on_startup(&fx.store, &fx.root, &[PathBuf::from("/rt/chrome")]);
    assert_eq!(
        report.orphans_adopted, 0,
        "foreign executable is not adopted"
    );
    fx.procs.remove(600);
    fx.procs.add_full(
        601,
        Some(1),
        1000,
        "/rt/chrome",
        vec!["chrome".into(), flag(&fx)],
    );
    let report = fx
        .sup()
        .reconcile_on_startup(&fx.store, &fx.root, &[PathBuf::from("/rt/chrome")]);
    assert_eq!(report.orphans_adopted, 1);
    assert_eq!(state(&fx), RunState::Running);
}

#[test]
fn interrupted_start_is_surfaced() {
    let fx = setup();
    fx.store
        .set_run_state(&fx.id, RunState::Starting, None)
        .unwrap_or_else(|e| panic!("{e}"));
    let report = fx.sup().reconcile_on_startup(&fx.store, &fx.root, &[]);
    assert_eq!(report.interrupted, 1);
    let p = fx.store.get_profile(&fx.id).ok().flatten();
    assert_eq!(p.as_ref().map(|p| p.state), Some(RunState::Stopped));
    assert_eq!(
        p.and_then(|p| p.last_error).as_deref(),
        Some("START_INTERRUPTED")
    );
}
