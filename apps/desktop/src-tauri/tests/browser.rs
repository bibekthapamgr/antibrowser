//! Milestone 03 exit criteria against a REAL Chromium (controlled-origin integration tests).
//!
//! Runs only when `PB_TEST_BROWSER` points at a browser executable (CI: the runtime from the manifest pipeline;
//! locally: any Chromium). Set `PB_TEST_BROWSER_REQUIRED=1` to fail instead of skipping when it is missing.
//! `PB_TEST_SWITCHES` may add allow-listed switches, e.g. `--ozone-platform=headless` (Linux CI without a display:
//! a normal browser that draws nowhere; `--headless=new` is a different shutdown path and is not used here).
//!
//! A local HTTP server on 127.0.0.1 serves a page that writes or reads a cookie, localStorage, IndexedDB, Cache
//! Storage and a service worker, then POSTs what it saw back to the server. The tests drive the manager's real
//! launch/stop/supervisor code (`AppState`), with the real process launcher and inspector:
//!  - profile B sees none of profile A's storage; A sees its own after a restart;
//!  - a crashed A is reported as crashed and never attached to B;
//!  - repeated launch requests create one browser;
//!  - no remote-debugging endpoint is opened;
//!  - ten launch/close cycles end cleanly every time and keep the profile's data.

use pb_desktop_lib::events::RecordingSink;
use pb_desktop_lib::operations::OpStatus;
use pb_desktop_lib::runtime::{HttpsFetcher, RuntimeConfig};
use pb_desktop_lib::state::AppState;
use pb_runtime::{
    BrowserInstall, ProcessInspector, ProfileId, RunState, SystemInspector, SystemLauncher, procs,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static SERIAL: Mutex<()> = Mutex::new(());

const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>pb isolation</title><script>
(async () => {
  const q = new URLSearchParams(location.search);
  const mode = q.get('mode'), tag = q.get('tag'), who = q.get('who');
  const out = { who, mode };
  const idb = (write) => new Promise((ok) => {
    const r = indexedDB.open('pb', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => ok(null);
    r.onsuccess = () => {
      try {
        const tx = r.result.transaction('kv', write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('kv');
        if (write) { store.put(tag, 'pb_iso'); tx.oncomplete = () => ok(tag); tx.onerror = () => ok(null); }
        else { const g = store.get('pb_iso'); g.onsuccess = () => ok(g.result ?? null); g.onerror = () => ok(null); }
      } catch (e) { ok(null); }
    };
  });
  try {
    if (mode === 'write') {
      document.cookie = 'pb_iso=' + tag + '; max-age=86400; path=/; SameSite=Lax';
      localStorage.setItem('pb_iso', tag);
      await idb(true);
      const c = await caches.open('pb');
      await c.put('/pb-cached', new Response(tag));
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    }
    if (mode === 'count') {
      localStorage.setItem('pb_count', String(Number(localStorage.getItem('pb_count') || 0) + 1));
    }
    out.cookie = document.cookie;
    out.local = localStorage.getItem('pb_iso');
    out.idb = await idb(false);
    const m = await (await caches.open('pb')).match('/pb-cached');
    out.cache = m ? await m.text() : null;
    out.sw = (await navigator.serviceWorker.getRegistrations()).length;
    out.count = Number(localStorage.getItem('pb_count') || 0);
  } catch (e) { out.error = String(e); }
  await fetch('/report?who=' + encodeURIComponent(who), { method: 'POST', body: JSON.stringify(out) });
})();
</script>"#;

const SW: &str = "self.addEventListener('install', () => self.skipWaiting());\n\
                  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n";

struct Server {
    port: u16,
    reports: Arc<Mutex<HashMap<String, Value>>>,
    /// Request lines received ("GET /?mode=…"), for failure diagnostics.
    requests: Arc<Mutex<Vec<String>>>,
}

impl Server {
    /// Storage is per origin (scheme, host AND port), so the portability spike uses a fixed port on every machine.
    fn start() -> Self {
        let port: u16 = if std::env::var("PB_PORTABILITY").is_ok() {
            47615
        } else {
            0
        };
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| panic!("{e}"));
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let reports: Arc<Mutex<HashMap<String, Value>>> = Arc::default();
        let requests: Arc<Mutex<Vec<String>>> = Arc::default();
        let store = reports.clone();
        let log = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let store = store.clone();
                let log = log.clone();
                std::thread::spawn(move || handle(stream, &store, &log));
            }
        });
        Self {
            port,
            reports,
            requests,
        }
    }

    fn url(&self, mode: &str, who: &str, tag: &str) -> String {
        format!(
            "http://127.0.0.1:{}/?mode={mode}&who={who}&tag={tag}",
            self.port
        )
    }

    fn wait_report(&self, who: &str) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Some(v) = self.reports.lock().ok().and_then(|mut r| r.remove(who)) {
                return Some(v);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }
}

fn handle(stream: TcpStream, reports: &Mutex<HashMap<String, Value>>, log: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length.min(1 << 20)];
    let _ = reader.read_exact(&mut body);
    if let Ok(mut l) = log.lock() {
        l.push(request_line.trim().chars().take(120).collect());
    }
    let target = request_line.split_whitespace().nth(1).unwrap_or("/");
    let (status, ctype, payload) = if target.starts_with("/report") {
        let who = target
            .split("who=")
            .nth(1)
            .unwrap_or("")
            .split('&')
            .next()
            .unwrap_or("")
            .to_owned();
        if let (Ok(v), Ok(mut r)) = (serde_json::from_slice::<Value>(&body), reports.lock()) {
            r.insert(who, v);
        }
        ("204 No Content", "text/plain", String::new())
    } else if target.starts_with("/sw.js") {
        ("200 OK", "text/javascript", SW.to_owned())
    } else if target == "/favicon.ico" {
        ("404 Not Found", "text/plain", String::new())
    } else {
        ("200 OK", "text/html; charset=utf-8", PAGE.to_owned())
    };
    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
}

struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    server: Server,
}

fn browser() -> Option<PathBuf> {
    match std::env::var("PB_TEST_BROWSER") {
        Ok(p) if !p.is_empty() => Some(PathBuf::from(p)),
        _ => {
            assert!(
                std::env::var("PB_TEST_BROWSER_REQUIRED").is_err(),
                "PB_TEST_BROWSER is required in this run"
            );
            eprintln!("skipped: set PB_TEST_BROWSER to run real-browser tests");
            None
        }
    }
}

fn env() -> Option<Env> {
    let exe = browser()?;
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let switches: Vec<String> = std::env::var("PB_TEST_SWITCHES")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let state = AppState::build(
        &tmp.path().join("data"),
        RuntimeConfig {
            manifest: (vec![], vec![]),
            trusted_keys: pb_desktop_lib::runtime::TRUSTED_KEYS.to_owned(),
            dev_override: Some(BrowserInstall {
                executable: exe,
                revision: std::env::var("PB_TEST_BROWSER_VERSION").unwrap_or_else(|_| "dev".into()),
            }),
            fetcher: Arc::new(HttpsFetcher),
            switches,
        },
        Arc::new(SystemLauncher),
        Arc::new(SystemInspector::default()),
        Arc::new(RecordingSink::default()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    state
        .create_workspace("Isolation tests")
        .unwrap_or_else(|e| panic!("{e:?}"));
    Some(Env {
        _tmp: tmp,
        state,
        server: Server::start(),
    })
}

/// Never leave a browser running after a test, even a failed one (a leftover browser would keep CI log pipes open
/// and leak into the next test).
impl Drop for Env {
    fn drop(&mut self) {
        let Ok(store) = self.state.store() else {
            return;
        };
        for id in self.state.supervisor.running_ids() {
            let _ = self.state.supervisor.force_stop(&store, &id);
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while self.state.supervisor.running_count() > 0 && Instant::now() < deadline {
            self.state.poll_once();
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Env {
    fn profile(&self, name: &str) -> ProfileId {
        let v = self
            .state
            .create_profile(name, None, None)
            .unwrap_or_else(|e| panic!("{e:?}"));
        ProfileId::parse(&v.id).unwrap_or_else(|e| panic!("{e}"))
    }

    fn wait(&self, op: &str, timeout: Duration) -> OpStatus {
        let deadline = Instant::now() + timeout;
        loop {
            self.state.poll_once();
            let st = self.state.ops.get(op).map(|o| o.status);
            if st != Some(OpStatus::Running) || Instant::now() > deadline {
                return st.unwrap_or(OpStatus::Failed);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Opens `id` on the test page and returns what the page reported.
    fn visit(&self, id: &ProfileId, mode: &str, who: &str, tag: &str) -> Value {
        eprintln!("pb-step: open {who} ({mode})");
        let url = self.server.url(mode, who, tag);
        let op = self
            .state
            .launch_profile(id, Some(&url))
            .unwrap_or_else(|e| panic!("launch {who}: {e:?}"));
        assert_eq!(
            self.wait(&op.operation_id, Duration::from_secs(60)),
            OpStatus::Succeeded,
            "launch {who}: {:?}",
            self.state.ops.get(&op.operation_id)
        );
        let report = self
            .server
            .wait_report(who)
            .unwrap_or_else(|| panic!("no report from {who} within 60 s; {}", self.diagnose(id)));
        assert!(report.get("error").is_none(), "{who}: {report}");
        if mode != "read" && cfg!(not(any(windows, target_os = "macos"))) {
            // Linux closes with SIGTERM ("session ending"), which does not flush storage written moments ago;
            // give Chromium's own commit timers time to run. Windows/macOS use a normal quit that flushes.
            std::thread::sleep(Duration::from_secs(if mode == "write" { 8 } else { 5 }));
        }
        report
    }

    fn close(&self, id: &ProfileId) {
        eprintln!("pb-step: close {id}");
        let op = self
            .state
            .stop_profile(id, false)
            .unwrap_or_else(|e| panic!("stop: {e:?}"));
        if self.wait(&op.operation_id, Duration::from_secs(30)) != OpStatus::Succeeded {
            panic!(
                "graceful close: {:?}; {}; {}",
                self.state.ops.get(&op.operation_id),
                self.close_diagnosis(id),
                self.diagnose(id)
            );
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.state.supervisor.is_tracked(id) && Instant::now() < deadline {
            self.state.poll_once();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!self.state.supervisor.is_tracked(id), "run ended");
    }

    /// Windows: what the OS says about a browser that did not close (session, window title), and whether a plain
    /// close request (WM_CLOSE to the main process only) works when sent by hand.
    fn close_diagnosis(&self, id: &ProfileId) -> String {
        if !cfg!(windows) {
            return String::new();
        }
        let Some(pid) = self.mains(id).first().copied() else {
            return "no browser main process left".into();
        };
        let run = |program: &str, args: &[&str]| -> String {
            std::process::Command::new(program)
                .args(args)
                .output()
                .map(|o| {
                    format!(
                        "exit {} out=[{}] err=[{}]",
                        o.status,
                        String::from_utf8_lossy(&o.stdout)
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" "),
                        String::from_utf8_lossy(&o.stderr)
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                })
                .unwrap_or_else(|e| format!("<{e}>"))
        };
        let filter = format!("PID eq {pid}");
        let tasklist = run("tasklist", &["/V", "/FO", "LIST", "/FI", &filter]);
        let pid_s = pid.to_string();
        let manual = run("taskkill", &["/PID", &pid_s]);
        std::thread::sleep(Duration::from_secs(8));
        let exited = !self.mains(id).contains(&pid);
        format!(
            "close diagnosis: tasklist=[{tasklist}] | manual taskkill (no /T)=[{manual}] | main exited 8 s later: {exited}"
        )
    }

    /// One line describing the profile's browser processes and folder (shown when a test fails, since CI logs
    /// are often only available as annotations).
    fn diagnose(&self, id: &ProfileId) -> String {
        let ud = self.user_data(id);
        let snapshot = self.state.supervisor.inspector().snapshot();
        let mains = procs::browser_mains(&snapshot, &ud);
        let procs: Vec<String> = snapshot
            .iter()
            .filter(|p| {
                p.args.iter().any(|a| {
                    a.starts_with("--user-data-dir=") && a.ends_with(&*ud.to_string_lossy())
                })
            })
            .map(|p| {
                let kind = p
                    .args
                    .iter()
                    .find_map(|a| a.strip_prefix("--type="))
                    .unwrap_or("browser");
                format!("{}:{kind}", p.pid)
            })
            .collect();
        let list = |dir: PathBuf| -> String {
            std::fs::read_dir(dir)
                .map(|r| {
                    let mut v: Vec<String> = r
                        .filter_map(Result::ok)
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .collect();
                    v.sort();
                    v.join(",")
                })
                .unwrap_or_else(|e| format!("<{e}>"))
        };
        let args = mains.first().map(|m| m.args.join(" ")).unwrap_or_default();
        let requests = self
            .server
            .requests
            .lock()
            .map(|r| {
                r.iter()
                    .rev()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ; ")
            })
            .unwrap_or_default();
        // Chromium's own log, when the run enabled it (--enable-logging): the lines that explain failures.
        let chrome_log = std::fs::read_to_string(ud.join("chrome_debug.log"))
            .map(|t| {
                let lines: Vec<String> = t
                    .lines()
                    .filter(|l| l.contains("ERROR") || l.contains("WARNING") || l.contains("FATAL"))
                    .map(|l| l.chars().take(220).collect())
                    .collect();
                lines[lines.len().saturating_sub(25)..].join(" ;; ")
            })
            .unwrap_or_else(|_| "<no chrome_debug.log>".into());
        format!(
            "requests (newest first)=[{requests}] | chrome log=[{chrome_log}] | user-data={} | processes=[{}] | main args=[{args}] | status={} | top=[{}] | Default=[{}]",
            ud.display(),
            procs.join(" "),
            self.state
                .profile_status(id)
                .map(|s| serde_json::to_string(&s.profile).unwrap_or_default())
                .unwrap_or_default(),
            list(ud.clone()),
            list(ud.join("Default")),
        )
    }

    fn user_data(&self, id: &ProfileId) -> PathBuf {
        self.state.root.dirs(id).user_data
    }

    fn mains(&self, id: &ProfileId) -> Vec<u32> {
        let snapshot = self.state.supervisor.inspector().snapshot();
        procs::browser_mains(&snapshot, &self.user_data(id))
            .iter()
            .map(|p| p.pid)
            .collect()
    }

    fn last_outcome(&self, id: &ProfileId) -> String {
        self.state
            .store()
            .ok()
            .and_then(|s| s.runs_for(id, 1).ok())
            .and_then(|r| r.first().map(|r| r.outcome.clone()))
            .unwrap_or_default()
    }

    fn run_state(&self, id: &ProfileId) -> RunState {
        self.state
            .store()
            .ok()
            .and_then(|s| s.get_profile(id).ok().flatten())
            .map(|p| p.state)
            .unwrap_or(RunState::Stopped)
    }
}

fn empty(report: &Value) -> bool {
    report["cookie"] == json!("")
        && report["local"].is_null()
        && report["idb"].is_null()
        && report["cache"].is_null()
        && report["sw"] == json!(0)
}

#[test]
fn storage_is_isolated_between_profiles_and_survives_restart() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(env) = env() else { return };
    let a = env.profile("A");
    let b = env.profile("B");

    let wrote = env.visit(&a, "write", "a-write", "alpha");
    assert_eq!(wrote["local"], json!("alpha"));
    assert_eq!(wrote["idb"], json!("alpha"));
    assert_eq!(wrote["cache"], json!("alpha"));
    assert!(
        wrote["cookie"]
            .as_str()
            .is_some_and(|c| c.contains("pb_iso=alpha"))
    );
    assert!(wrote["sw"].as_u64().is_some_and(|n| n >= 1));
    // No debug endpoint while running: Chromium writes DevToolsActivePort whenever remote debugging is on.
    assert!(!env.user_data(&a).join("DevToolsActivePort").exists());
    let snapshot = env.state.supervisor.inspector().snapshot();
    for p in &snapshot {
        if procs::browser_mains(&snapshot, &env.user_data(&a))
            .iter()
            .any(|m| m.pid == p.pid)
        {
            assert!(
                !p.args
                    .iter()
                    .any(|x| x.contains("remote-debugging") || x == "--no-sandbox"),
                "{:?}",
                p.args
            );
        }
    }
    env.close(&a);
    assert_eq!(env.last_outcome(&a), "clean");

    let seen_by_b = env.visit(&b, "read", "b-read", "-");
    assert!(
        empty(&seen_by_b),
        "profile B must not see A's storage: {seen_by_b}"
    );
    env.close(&b);

    let again = env.visit(&a, "read", "a-read", "-");
    assert_eq!(again["local"], json!("alpha"), "{again}");
    assert_eq!(again["idb"], json!("alpha"));
    assert_eq!(again["cache"], json!("alpha"));
    // Windows and macOS close the browser with a normal quit, which flushes the cookie database. On Linux
    // (development only) the graceful close is SIGTERM, which may drop cookies written in the last ~30 s.
    if cfg!(any(windows, target_os = "macos")) {
        assert!(
            again["cookie"]
                .as_str()
                .is_some_and(|c| c.contains("pb_iso=alpha")),
            "{again}"
        );
    }
    assert!(again["sw"].as_u64().is_some_and(|n| n >= 1));
    env.close(&a);
}

#[test]
fn a_crash_is_reported_and_never_attached_to_another_profile() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(env) = env() else { return };
    let a = env.profile("A");
    let b = env.profile("B");
    env.visit(&a, "write", "a-write", "alpha");
    env.close(&a);

    env.visit(&a, "read", "a-read", "-");
    let a_pid = env
        .mains(&a)
        .first()
        .copied()
        .unwrap_or_else(|| panic!("A running"));
    // Simulate a crash: hard-kill the browser main process (no graceful shutdown).
    assert!(SystemInspector::default().kill(a_pid));
    let deadline = Instant::now() + Duration::from_secs(30);
    while env.state.supervisor.is_tracked(&a) && Instant::now() < deadline {
        env.state.poll_once();
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(env.run_state(&a), RunState::Crashed);
    assert!(matches!(
        env.last_outcome(&a).as_str(),
        "crashed" | "early_exit"
    ));

    let seen_by_b = env.visit(&b, "read", "b-read", "-");
    assert!(empty(&seen_by_b), "{seen_by_b}");
    let b_pid = env.mains(&b).first().copied().unwrap_or(0);
    assert_ne!(b_pid, a_pid);
    assert!(env.mains(&a).is_empty());
    assert_eq!(
        env.run_state(&a),
        RunState::Crashed,
        "B's run did not change A's state"
    );
    env.close(&b);

    // Reopening A (a user action) works and its data is still there.
    let again = env.visit(&a, "read", "a-reopen", "-");
    assert_eq!(again["local"], json!("alpha"), "{again}");
    env.close(&a);
}

#[test]
fn repeated_launch_requests_start_one_browser() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(env) = env() else { return };
    let a = env.profile("A");
    let url = env.server.url("read", "a-double", "-");
    let ops: Vec<String> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..5)
            .map(|_| {
                s.spawn(|| {
                    env.state
                        .launch_profile(&a, Some(&url))
                        .map(|o| o.operation_id)
                        .unwrap_or_else(|e| panic!("{e:?}"))
                })
            })
            .collect();
        hs.into_iter()
            .map(|h| h.join().unwrap_or_else(|_| panic!("join")))
            .collect()
    });
    assert!(ops.iter().all(|o| o == &ops[0]));
    assert_eq!(
        env.wait(&ops[0], Duration::from_secs(60)),
        OpStatus::Succeeded
    );
    env.server
        .wait_report("a-double")
        .unwrap_or_else(|| panic!("no report; {}", env.diagnose(&a)));
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(
        env.mains(&a).len(),
        1,
        "exactly one browser for the profile"
    );
    env.close(&a);
}

#[test]
fn ten_launch_close_cycles_stay_clean() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(env) = env() else { return };
    let a = env.profile("A");
    for i in 1..=10 {
        let r = env.visit(&a, "count", &format!("cycle-{i}"), "-");
        assert_eq!(r["count"], json!(i), "cycle {i}: {r}");
        env.close(&a);
        assert_eq!(env.last_outcome(&a), "clean", "cycle {i}");
        assert_eq!(env.run_state(&a), RunState::Stopped);
        assert!(env.mains(&a).is_empty(), "cycle {i}: no browser left");
        assert!(
            pb_runtime::prefs::exit_record(&env.user_data(&a)).is_some_and(|r| r.clean),
            "cycle {i}: Chromium recorded an orderly shutdown"
        );
    }
    let runs = env
        .state
        .store()
        .ok()
        .and_then(|s| s.runs_for(&a, 20).ok())
        .unwrap_or_default();
    assert_eq!(runs.len(), 10);
    assert!(runs.iter().all(|r| r.outcome == "clean"));
}

// ---------------------------------------------------------------------------------------------- portability spike

fn platform_name() -> &'static str {
    pb_desktop_lib::state::platform()
}

/// Milestone 03 step 8, sealed since milestone 07 (portability with real cookie encryption, through the same
/// encrypted snapshot format organization backups use). Driven by the runtime pipeline:
/// - `PB_PORTABILITY=create PB_PORTABILITY_DIR=<dir>`: a profile signs in to the test page (cookie, localStorage,
///   IndexedDB), closes cleanly, and is sealed (caches and lock files excluded, compressed, AES-256-GCM, bound to
///   a test organization/profile/snapshot) to `<dir>/profile.pbseal`. The same machine then opens it into a NEW
///   profile directory and records the result with the label the app shows (`supported`).
/// - `PB_PORTABILITY=verify PB_PORTABILITY_DIR=<dir> PB_PORTABILITY_RESULT=<file>`: on another machine (a fresh
///   CI runner), open that file into a new profile and record what survived, with the label the app shows there
///   (`sign_in_required`). The test data key travels with the file: it protects nothing but test data.
#[test]
fn portability_spike() {
    let Ok(mode) = std::env::var("PB_PORTABILITY") else {
        return;
    };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(env) = env() else { return };
    let dir = PathBuf::from(
        std::env::var("PB_PORTABILITY_DIR").unwrap_or_else(|_| panic!("PB_PORTABILITY_DIR")),
    );
    let sealed = dir.join("profile.pbseal");
    let binding = pb_seal::Binding {
        kind: pb_seal::Kind::OrgSnapshot,
        org_id: Some("org_01J9ZSEED0PORTAB1E000000000".into()),
        profile_id: "prf_01J9ZSEED0PORTAB1E000000000".into(),
        object_id: "snp_01J9ZSEED0PORTAB1E000000000".into(),
        key_version: "okv_01J9ZSEED0PORTAB1E000000000".into(),
    };
    let browser = std::env::var("PB_TEST_BROWSER_VERSION").unwrap_or_else(|_| "0.0.0.0".into());

    let restore_and_read = |who: &str| -> Value {
        let key = pb_seal::SealKey::from_base64(
            &std::fs::read_to_string(dir.join("key.b64")).unwrap_or_else(|e| panic!("{e}")),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let target = env.profile("Restored");
        let dirs = env
            .state
            .root
            .ensure(&target)
            .unwrap_or_else(|e| panic!("{e}"));
        let fresh = dirs.root.join("user-data.incoming");
        std::fs::create_dir_all(&fresh).unwrap_or_else(|e| panic!("{e}"));
        pb_seal::open_profile(
            &sealed,
            &key,
            &binding,
            &fresh,
            &pb_seal::Limits::default(),
            &std::sync::atomic::AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_or_else(|e| panic!("open: {e}"));
        std::fs::remove_dir_all(&dirs.user_data).unwrap_or_else(|e| panic!("{e}"));
        std::fs::rename(fresh.join("user-data"), &dirs.user_data).unwrap_or_else(|e| panic!("{e}"));
        let _ = std::fs::remove_dir_all(&fresh);
        let r = env.visit(&target, "read", who, "-");
        env.close(&target);
        r
    };
    let summarize = |source: &str, same_machine: bool, r: &Value| {
        // The label the app shows after this restore (ADR-0002; pb_sync::portability).
        let label = pb_sync::portability::classify(
            source,
            &browser,
            1,
            Some(if same_machine {
                "this-machine"
            } else {
                "source-machine"
            }),
            &pb_sync::portability::Here {
                platform: platform_name(),
                device_id: Some("this-machine"),
                browser_version: Some(&browser),
            },
        );
        json!({
            "source": source,
            "target": platform_name(),
            "same_machine": same_machine,
            "browser_version": std::env::var("PB_TEST_BROWSER_VERSION").ok(),
            "sealed": true,
            "opened": true,
            "cookie": r["cookie"].as_str().is_some_and(|c| c.contains("pb_iso=portable")),
            "local_storage": r["local"] == json!("portable"),
            "indexeddb": r["idb"] == json!("portable"),
            "label": label.portability,
        })
    };

    match mode.as_str() {
        "create" => {
            let source = env.profile("Source");
            env.visit(&source, "write", "p-write", "portable");
            if cfg!(not(any(windows, target_os = "macos"))) {
                // Linux closes with SIGTERM: let Chromium's 30 s cookie commit run first (see the module docs).
                std::thread::sleep(Duration::from_secs(32));
            }
            env.close(&source);
            std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("{e}"));
            let key = pb_seal::SealKey::generate().unwrap_or_else(|e| panic!("{e}"));
            std::fs::write(dir.join("key.b64"), key.to_base64().as_bytes())
                .unwrap_or_else(|e| panic!("{e}"));
            let outcome = pb_seal::seal_profile(
                &env.user_data(&source),
                &[],
                &key,
                &binding,
                &sealed,
                &std::sync::atomic::AtomicBool::new(false),
                &mut |_| {},
            )
            .unwrap_or_else(|e| panic!("seal: {e}"));
            eprintln!(
                "sealed {} files ({} bytes) into {} bytes",
                outcome.stats.files, outcome.stats.bytes, outcome.sealed_bytes
            );
            std::fs::write(
                dir.join("meta.json"),
                json!({ "platform": platform_name() }).to_string(),
            )
            .unwrap_or_else(|e| panic!("{e}"));
            let r = restore_and_read("p-same");
            let result = summarize(platform_name(), true, &r);
            eprintln!("portability (same machine, new path): {result}");
            if let Ok(out) = std::env::var("PB_PORTABILITY_RESULT") {
                std::fs::write(out, result.to_string()).unwrap_or_else(|e| panic!("{e}"));
            }
            // Same machine, new directory must keep site data (ADR-0002 v1 promise), and the label the app shows
            // ("supported": sign-ins kept) must be true.
            assert_eq!(result["local_storage"], json!(true), "{result}");
            assert_eq!(result["indexeddb"], json!(true), "{result}");
            assert_eq!(result["label"], json!("supported"), "{result}");
            assert_eq!(
                result["cookie"],
                json!(true),
                "the label promises kept sign-ins: {result}"
            );
        }
        "verify" => {
            let meta: Value =
                serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap_or_default())
                    .unwrap_or_default();
            let source = meta["platform"].as_str().unwrap_or("unknown").to_owned();
            let r = restore_and_read("p-other");
            let result = summarize(&source, false, &r);
            // Another machine is labelled "sign-in required": site data must be back (the label's promise).
            assert_eq!(result["label"], json!("sign_in_required"), "{result}");
            assert_eq!(result["local_storage"], json!(true), "{result}");
            assert_eq!(result["indexeddb"], json!(true), "{result}");
            eprintln!("portability (other machine): {result}");
            let out = std::env::var("PB_PORTABILITY_RESULT")
                .unwrap_or_else(|_| panic!("PB_PORTABILITY_RESULT"));
            std::fs::write(out, result.to_string()).unwrap_or_else(|e| panic!("{e}"));
        }
        other => panic!("unknown PB_PORTABILITY mode {other}"),
    }
}
