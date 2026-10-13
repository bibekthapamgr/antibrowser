//! End-to-end: the desktop's sync engine and HTTP client against the real API, PostgreSQL, S3-compatible storage
//! (SeaweedFS) and the verification worker. Two people on two computers back up and restore one organization
//! profile; the network drops mid-upload and an answer is lost; a stale computer gets a conflict; another
//! organization's member gets nothing.
//!
//! Milestone 08 (`sessions_against_the_real_api`): two computers contend for one shared profile — simultaneous opens,
//! a request, a handoff with a note, a forced takeover with a stale upload kept as a recovery copy, removed access —
//! and the audit trail of the sequence.
//!
//! Runs when `PB_E2E_API` names the file written by `services/api/scripts/e2e-server.ts` (CI job "sync end to
//! end"); skipped otherwise.

use pb_cloud::{Http, Method, Transfer};
use pb_sync::api::{
    CommitRequest, InitRequest, InitResult, Operation, PartUrl, RestorePlan, SnapshotInfo,
    StoredPart,
};
use pb_sync::portability::{self, Here, Portability};
use pb_sync::rest::{BearerTransport, RestApi, Transport};
use pb_sync::{
    ApiError, Engine, Job, JobStore, MemoryJobs, ObjectError, Objects, OpenRequest, Outcome, Poll,
    RestoreChecks, RestoreJob, RestoreState, RestoreTarget, SessionApi, SessionOutcome, Source,
    SyncApi, SyncError, UploadState, new_upload,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

fn quiet(_: &str, _: &'static str, _: u64, _: u64) {}

const POLL: Poll = Poll {
    interval: Duration::from_millis(300),
    max_wait: Duration::from_secs(60),
};

struct Actor {
    api: RestApi<BearerTransport>,
    device: String,
}

fn actor(cfg: &Value, who: &str) -> Actor {
    let s = |k: &str| cfg[who][k].as_str().unwrap_or_default().to_owned();
    Actor {
        api: RestApi {
            transport: BearerTransport {
                http: Http::new(true),
                base: cfg["base_url"].as_str().unwrap_or_default().to_owned(),
                token: s("token"),
            },
            device: s("device"),
        },
        device: s("device"),
    }
}

/// Fails chosen calls once: before they reach the server, or after (the answer is lost).
#[derive(Default)]
struct Faults {
    api_after: Mutex<Vec<&'static str>>,
    put_before: Mutex<u32>,
}

struct Flaky<'a> {
    inner: &'a dyn SyncApi,
    objects: &'a dyn Objects,
    faults: &'a Faults,
}

impl Flaky<'_> {
    fn lose_answer(&self, call: &'static str) -> bool {
        let mut f = self
            .faults
            .api_after
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match f.iter().position(|c| *c == call) {
            Some(i) => {
                f.remove(i);
                true
            }
            None => false,
        }
    }
    fn after<T>(&self, call: &'static str, r: Result<T, ApiError>) -> Result<T, ApiError> {
        if r.is_ok() && self.lose_answer(call) {
            return Err(ApiError::Offline);
        }
        r
    }
}

impl SyncApi for Flaky<'_> {
    fn acquire_lease(&self, o: &str, p: &str, k: &str) -> Result<String, ApiError> {
        let r = self.inner.acquire_lease(o, p, k);
        self.after("acquire_lease", r)
    }
    fn renew_lease(&self, o: &str, p: &str, f: &str) -> Result<(), ApiError> {
        self.inner.renew_lease(o, p, f)
    }
    fn release_lease(&self, o: &str, p: &str, f: &str) -> Result<(), ApiError> {
        self.inner.release_lease(o, p, f)
    }
    fn init(&self, o: &str, p: &str, k: &str, r: &InitRequest) -> Result<InitResult, ApiError> {
        let res = self.inner.init(o, p, k, r);
        self.after("init", res)
    }
    fn part_urls(&self, o: &str, p: &str, s: &str, n: &[u32]) -> Result<Vec<PartUrl>, ApiError> {
        self.inner.part_urls(o, p, s, n)
    }
    fn stored_parts(&self, o: &str, p: &str, s: &str) -> Result<Vec<StoredPart>, ApiError> {
        self.inner.stored_parts(o, p, s)
    }
    fn commit(&self, o: &str, p: &str, s: &str, r: &CommitRequest) -> Result<Operation, ApiError> {
        let res = self.inner.commit(o, p, s, r);
        self.after("commit", res)
    }
    fn cancel(&self, o: &str, p: &str, s: &str) -> Result<(), ApiError> {
        self.inner.cancel(o, p, s)
    }
    fn operation(&self, o: &str, op: &str) -> Result<Operation, ApiError> {
        self.inner.operation(o, op)
    }
    fn restore_plan(&self, o: &str, p: &str, s: Option<&str>) -> Result<RestorePlan, ApiError> {
        self.inner.restore_plan(o, p, s)
    }
    fn latest(&self, o: &str, p: &str) -> Result<Option<SnapshotInfo>, ApiError> {
        self.inner.latest(o, p)
    }
}

impl Objects for Flaky<'_> {
    fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, ObjectError> {
        {
            let mut n = self
                .faults
                .put_before
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if *n > 0 {
                *n -= 1;
                return Err(ObjectError::Offline);
            }
        }
        self.objects.put_part(url, bytes)
    }
    fn download(
        &self,
        url: &str,
        start: u64,
        out: &mut dyn Write,
        restart: &mut dyn FnMut() -> io::Result<()>,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64, ObjectError> {
        self.objects
            .download(url, start, out, restart, cancel, progress)
    }
}

struct Checks {
    device: String,
}

impl RestoreChecks for Checks {
    fn compatible(&self, s: &SnapshotInfo) -> Result<(), String> {
        let v = verdict(s, &self.device);
        if v == Portability::Unsupported {
            Err("UNSUPPORTED".into())
        } else {
            Ok(())
        }
    }
    fn free_space(&self, _: &Path) -> io::Result<u64> {
        Ok(u64::MAX)
    }
}

fn verdict(s: &SnapshotInfo, device: &str) -> Portability {
    portability::classify(
        &s.platform,
        &s.browser_version,
        s.schema_version,
        s.device_id.as_deref(),
        &Here {
            platform: "linux-x64",
            device_id: Some(device),
            browser_version: Some("155.0.8059.39"),
        },
    )
    .portability
}

fn write(path: &Path, bytes: &[u8]) {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).unwrap_or_else(|e| panic!("{e}"));
    }
    fs::write(path, bytes).unwrap_or_else(|e| panic!("{e}"));
}

fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("{e}"))
            .flatten()
        {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let rel = p
                    .strip_prefix(base)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, fs::read(&p).unwrap_or_default());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn source(p: &Path) -> Source<'_> {
    Source {
        user_data: p,
        settings_json: Some(br#"{"format":"project-browser-profile-settings","version":1}"#),
        platform: "linux-x64",
        browser_version: "155.0.8059.39",
        app_version: "e2e",
    }
}

#[allow(clippy::too_many_arguments)] // a test helper: every argument is a step input
fn run_upload(
    api: &dyn SyncApi,
    objects: &dyn Objects,
    jobs: &MemoryJobs,
    work: &Path,
    org: &str,
    profile: &str,
    base: i64,
    data: &Path,
) -> (pb_sync::UploadJob, Vec<Result<Outcome, SyncError>>) {
    let never = AtomicBool::new(false);
    let engine = Engine {
        api,
        objects,
        jobs,
        work_dir: work,
        cancel: &never,
        progress: &quiet,
        poll: POLL,
    };
    let mut job = new_upload("prf_01HZZZZZZZZZZZZZZZZZZZZZZZ", org, profile, base)
        .unwrap_or_else(|e| panic!("{e}"));
    jobs.save(&Job::Upload(job.clone())).unwrap_or_default();
    let mut results = vec![];
    for _ in 0..6 {
        // Each attempt starts from what was saved, as after an app restart.
        if let Some(Job::Upload(saved)) = jobs.load(&job.id) {
            job = saved;
        }
        let r = engine.upload(&mut job, Some(&source(data)));
        let done = matches!(r, Ok(Outcome::Finished));
        results.push(r);
        if done {
            break;
        }
    }
    (job, results)
}

#[allow(clippy::too_many_arguments)]
fn restore(
    api: &dyn SyncApi,
    objects: &dyn Objects,
    work: &Path,
    dest: &Path,
    org: &str,
    profile: &str,
    snapshot: Option<&str>,
    device: &str,
) -> (RestoreJob, Option<pb_sync::Opened>) {
    let never = AtomicBool::new(false);
    let jobs = MemoryJobs::default();
    let engine = Engine {
        api,
        objects,
        jobs: &jobs,
        work_dir: work,
        cancel: &never,
        progress: &quiet,
        poll: POLL,
    };
    let mut job = RestoreJob::new(
        "sj_e2e".into(),
        org,
        profile,
        "prf_01HYYYYYYYYYYYYYYYYYYYYYYY",
        RestoreTarget::Replace,
        snapshot,
    );
    let opened = engine
        .restore(
            &mut job,
            dest,
            &Checks {
                device: device.into(),
            },
        )
        .unwrap_or_else(|e| panic!("restore: {e:?}"));
    if opened.is_some() {
        engine
            .finish_restore(&mut job)
            .unwrap_or_else(|e| panic!("{e}"));
    }
    (job, opened)
}

#[test]
fn engine_against_the_real_api() {
    let Ok(path) = std::env::var("PB_E2E_API") else {
        eprintln!("skipped: PB_E2E_API is not set (see services/api/scripts/e2e-server.ts)");
        return;
    };
    let cfg: Value = serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{e}")))
        .unwrap_or_default();
    let org = cfg["org"].as_str().unwrap_or_default().to_owned();
    let profile = cfg["profile"].as_str().unwrap_or_default().to_owned();
    let owner = actor(&cfg, "owner");
    let operator = actor(&cfg, "operator");
    let transfer = Transfer::new(true);
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let root: PathBuf = tmp.path().to_path_buf();
    let mut report = vec![];

    // ---- 1. The owner's computer backs up (two 16 MiB parts); the network drops on a part and the commit's answer
    //         is lost. The job resumes from what it saved and commits exactly once.
    let data_a = root.join("a/user-data");
    write(&data_a.join("Default/Cookies"), b"owner-cookies");
    write(
        &data_a.join("Default/Local Storage/leveldb/000003.log"),
        b"owner-local-storage",
    );
    let mut big = vec![0u8; 20 * 1024 * 1024];
    getrandom::fill(&mut big).unwrap_or_else(|e| panic!("{e}"));
    write(&data_a.join("Default/IndexedDB/blob"), &big);
    write(&data_a.join("Default/Cache/data_0"), b"excluded");
    let v1_files = {
        let mut t = tree(&data_a);
        t.retain(|k, _| !k.starts_with("Default/Cache/"));
        t
    };
    let faults = Faults::default();
    *faults.put_before.lock().unwrap_or_else(|p| p.into_inner()) = 1;
    faults
        .api_after
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .extend(["commit", "init"]);
    let flaky = Flaky {
        inner: &owner.api,
        objects: &transfer,
        faults: &faults,
    };
    let jobs_a = MemoryJobs::default();
    let (job, results) = run_upload(
        &flaky,
        &flaky,
        &jobs_a,
        &root.join("sync-a"),
        &org,
        &profile,
        0,
        &data_a,
    );
    assert_eq!(job.state, UploadState::Committed, "{job:?} {results:?}");
    assert_eq!(job.version, Some(1));
    assert!(
        results
            .iter()
            .any(|r| matches!(r, Err(e) if e.is_transient())),
        "{results:?}"
    );
    assert!(
        job.sealed
            .as_ref()
            .is_some_and(|s| s.size > 16 * 1024 * 1024),
        "two parts"
    );
    let latest = owner
        .api
        .latest(&org, &profile)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        latest.as_ref().map(|s| s.version),
        Some(1),
        "committed once"
    );
    report.push(format!(
        "upload with a dropped part and a lost commit answer: committed once as version 1 after {} attempts",
        results.len()
    ));

    // ---- 2. The operator's computer restores it: same files; another device, so sign-in is required.
    let dest_b = root.join("b/incoming");
    let (rjob, opened) = restore(
        &operator.api,
        &transfer,
        &root.join("sync-b"),
        &dest_b,
        &org,
        &profile,
        None,
        &operator.device,
    );
    let opened = opened.unwrap_or_else(|| panic!("restore failed: {rjob:?}"));
    assert_eq!(rjob.state, RestoreState::Done);
    assert_eq!(tree(&dest_b.join("user-data")), v1_files);
    assert_eq!(
        verdict(&opened.snapshot, &operator.device),
        Portability::SignInRequired
    );
    // Development tokens carry no device session, so the server records no device for these snapshots; with a
    // signed-in device the computer that made it gets "supported" (desktop tests cover that case).
    if opened.snapshot.device_id.is_some() {
        assert_eq!(
            verdict(&opened.snapshot, &owner.device),
            Portability::Supported
        );
    }
    report.push(
        "restore on the operator's computer: identical files, labelled sign-in required".into(),
    );

    // ---- 3. The operator works and backs up version 2 (based on 1).
    let data_b = dest_b.join("user-data");
    write(&data_b.join("Default/Cookies"), b"operator-cookies");
    let jobs_b = MemoryJobs::default();
    let (job, results) = run_upload(
        &operator.api,
        &transfer,
        &jobs_b,
        &root.join("sync-b"),
        &org,
        &profile,
        1,
        &data_b,
    );
    assert_eq!(
        (job.state, job.version),
        (UploadState::Committed, Some(2)),
        "{results:?}"
    );

    // ---- 4. The owner's computer, still on version 1, gets a conflict: nothing is overwritten.
    write(&data_a.join("Default/Cookies"), b"owner-cookies-2");
    let (job, _) = run_upload(
        &owner.api,
        &transfer,
        &jobs_a,
        &root.join("sync-a"),
        &org,
        &profile,
        1,
        &data_a,
    );
    assert_eq!(
        (job.state, job.head_version),
        (UploadState::Conflict, Some(2))
    );
    assert_eq!(
        owner
            .api
            .latest(&org, &profile)
            .ok()
            .flatten()
            .map(|s| s.version),
        Some(2)
    );
    report.push("stale computer: VERSION_CONFLICT (head 2), head unchanged".into());

    // ---- 5. Rollback: version 1 restores on its own computer with everything intact.
    let v1 = {
        let (rj, opened) = restore(
            &owner.api,
            &transfer,
            &root.join("sync-a"),
            &root.join("a/rollback"),
            &org,
            &profile,
            None,
            &owner.device,
        );
        assert_eq!(opened.map(|o| o.snapshot.version), Some(2), "{rj:?}");
        // The history names version 1's snapshot.
        let hist = owner
            .api
            .transport
            .call(
                Method::Get,
                &format!("/v1/orgs/{org}/profiles/{profile}/snapshots"),
                None,
                None,
            )
            .unwrap_or_else(|e| panic!("{e}"));
        hist["items"]
            .as_array()
            .and_then(|a| a.iter().find(|s| s["version"] == 1))
            .and_then(|s| s["id"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let dest = root.join("a/v1");
    let (rj, opened) = restore(
        &owner.api,
        &transfer,
        &root.join("sync-a"),
        &dest,
        &org,
        &profile,
        Some(&v1),
        &owner.device,
    );
    assert_eq!(opened.map(|o| o.snapshot.version), Some(1), "{rj:?}");
    assert_eq!(tree(&dest.join("user-data")), v1_files);

    // ---- 6. Another organization's member: the profile does not exist for them.
    let outsider = actor(&cfg, "outsider");
    let (rj, opened) = restore(
        &outsider.api,
        &transfer,
        &root.join("sync-x"),
        &root.join("x"),
        &org,
        &profile,
        None,
        "dev_x",
    );
    assert!(opened.is_none());
    assert_eq!(
        (rj.state, rj.error_code.as_deref()),
        (RestoreState::Failed, Some("NOT_FOUND"))
    );
    assert!(matches!(
        outsider.api.latest(&org, &profile),
        Err(e) if e.is_code("NOT_FOUND")
    ));
    report.push("another organization's member: NOT_FOUND, nothing downloaded".into());

    for line in &report {
        println!("E2E: {line}");
    }
}

// ------------------------------------------------------------------------------------------------- milestone 08

fn open_request(a: &Actor) -> OpenRequest {
    OpenRequest {
        device_id: a.device.clone(),
        purpose: "session".into(),
        platform: "linux-x64".into(),
        browser_version: "155.0.8059.39".into(),
    }
}

fn key(prefix: &str) -> String {
    pb_sync::job::random_id(prefix).unwrap_or_else(|e| panic!("{e}"))
}

/// An upload under a session's lease (or, with `recovery`, a recovery copy of a lost one), retried a few times.
#[allow(clippy::too_many_arguments)]
fn session_upload(
    api: &dyn SyncApi,
    objects: &dyn Objects,
    work: &Path,
    org: &str,
    profile: &str,
    base: i64,
    data: &Path,
    lease: (&str, &str),
    recovery: bool,
) -> pb_sync::UploadJob {
    let never = AtomicBool::new(false);
    let jobs = MemoryJobs::default();
    let engine = Engine {
        api,
        objects,
        jobs: &jobs,
        work_dir: work,
        cancel: &never,
        progress: &quiet,
        poll: POLL,
    };
    let job = new_upload("prf_01HXXXXXXXXXXXXXXXXXXXXXXX", org, profile, base)
        .unwrap_or_else(|e| panic!("{e}"));
    let mut job = if recovery {
        job.as_recovery(lease.0, lease.1)
    } else {
        job.under_session(lease.0, lease.1)
    };
    for _ in 0..3 {
        if matches!(
            engine.upload(&mut job, Some(&source(data))),
            Ok(Outcome::Finished)
        ) || job.state.is_terminal()
        {
            break;
        }
    }
    job
}

fn raw(a: &Actor, method: Method, path: &str, body: Option<Value>) -> Result<Value, ApiError> {
    a.api.transport.call(method, path, None, body.as_ref())
}

#[test]
fn sessions_against_the_real_api() {
    let Ok(path) = std::env::var("PB_E2E_API") else {
        eprintln!("skipped: PB_E2E_API is not set (see services/api/scripts/e2e-server.ts)");
        return;
    };
    let cfg: Value = serde_json::from_slice(&fs::read(&path).unwrap_or_else(|e| panic!("{e}")))
        .unwrap_or_default();
    let org = cfg["org"].as_str().unwrap_or_default().to_owned();
    let profile = cfg["team_profile"].as_str().unwrap_or_default().to_owned();
    let grant = cfg["team_grant"].as_str().unwrap_or_default().to_owned();
    let owner = actor(&cfg, "owner");
    let operator = actor(&cfg, "operator");
    let transfer = Transfer::new(true);
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let root: PathBuf = tmp.path().to_path_buf();
    let prf = format!("/v1/orgs/{org}/profiles/{profile}");
    let mut report = vec![];
    let head = |a: &Actor| {
        a.api
            .latest(&org, &profile)
            .unwrap_or_else(|e| panic!("{e}"))
            .map_or(0, |s| s.version)
    };

    // ---- 1. Both computers open the profile at the same moment: exactly one session; the other is told who has it.
    let (ra, rb) = std::thread::scope(|s| {
        let a = s.spawn(|| {
            owner
                .api
                .open_session(&org, &profile, &key("open-a-"), &open_request(&owner))
        });
        let b = s.spawn(|| {
            operator
                .api
                .open_session(&org, &profile, &key("open-b-"), &open_request(&operator))
        });
        (
            a.join().unwrap_or_else(|_| panic!("thread")),
            b.join().unwrap_or_else(|_| panic!("thread")),
        )
    });
    let (winner, opened, held) = match (ra, rb) {
        (Ok(o), Err(ApiError::LeaseHeld(h))) => (&owner, o, h),
        (Err(ApiError::LeaseHeld(h)), Ok(o)) => (&operator, o, h),
        other => panic!("expected one session and one LEASE_HELD: {other:?}"),
    };
    assert!(!held.uncertain && !held.device_name.is_empty(), "{held:?}");
    winner
        .api
        .release_session(
            &org,
            &profile,
            &opened.lease.id,
            &opened.lease.fencing_token,
            SessionOutcome::Closed,
            None,
        )
        .unwrap_or_else(|e| panic!("{e}"));
    report.push(format!(
        "simultaneous opens from two computers: one session, the other LEASE_HELD naming the holder's device ({})",
        held.device_name
    ));

    // ---- 2. The operator opens it; the owner is refused and asks; the request arrives with the next heartbeat.
    let s1 = operator
        .api
        .open_session(&org, &profile, &key("open-"), &open_request(&operator))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(matches!(
        owner
            .api
            .open_session(&org, &profile, &key("open-"), &open_request(&owner)),
        Err(ApiError::LeaseHeld(_))
    ));
    raw(
        &owner,
        Method::Post,
        &format!("{prf}/handoff-requests"),
        Some(json!({ "note": "Need it for the refund queue" })),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let beat = operator
        .api
        .heartbeat(
            &org,
            &profile,
            &s1.lease.id,
            &s1.lease.fencing_token,
            Some("running"),
        )
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(beat.handoff_requests.len(), 1);
    assert_eq!(beat.lease.fencing_token, s1.lease.fencing_token);

    // ---- 3. The operator closes and hands off: the closing backup commits under the session, then the release
    //         carries the note. The owner opens it with the note and the newest version.
    let data_b = root.join("b/user-data");
    write(&data_b.join("Default/Cookies"), b"operator-session");
    let up = session_upload(
        &operator.api,
        &transfer,
        &root.join("sync-b"),
        &org,
        &profile,
        0,
        &data_b,
        (&s1.lease.id, &s1.lease.fencing_token),
        false,
    );
    assert_eq!(
        (up.state, up.version),
        (UploadState::Committed, Some(1)),
        "{up:?}"
    );
    operator
        .api
        .release_session(
            &org,
            &profile,
            &s1.lease.id,
            &s1.lease.fencing_token,
            SessionOutcome::Committed,
            Some("Refund half done"),
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let s2 = owner
        .api
        .open_session(&org, &profile, &key("open-"), &open_request(&owner))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(s2.head_version, 1);
    assert_eq!(
        s2.handoff_note.as_ref().map(|n| n.text.as_str()),
        Some("Refund half done")
    );
    owner
        .api
        .release_session(
            &org,
            &profile,
            &s2.lease.id,
            &s2.lease.fencing_token,
            SessionOutcome::Closed,
            None,
        )
        .unwrap_or_else(|e| panic!("{e}"));
    report.push("request delivered by heartbeat; handoff committed version 1, then the note reached the next holder".into());

    // ---- 4. Forced takeover: the operator's session is ended by the owner; its heartbeat is fenced, its stale
    //         upload is refused (nothing overwrites version 1), and its copy is kept as a recovery copy.
    let s3 = operator
        .api
        .open_session(&org, &profile, &key("open-"), &open_request(&operator))
        .unwrap_or_else(|e| panic!("{e}"));
    let took = raw(
        &owner,
        Method::Post,
        &format!("{prf}/force-takeover"),
        Some(json!({ "reason": "e2e: holder unreachable", "confirm": true })),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_ne!(took["fencing_token"], json!(s3.lease.fencing_token));
    assert!(matches!(
        operator.api.heartbeat(&org, &profile, &s3.lease.id, &s3.lease.fencing_token, None),
        Err(ApiError::Fenced { ref state }) if state == "taken_over"
    ));
    write(
        &data_b.join("Default/Cookies"),
        b"operator-unsynced-after-takeover",
    );
    let stale = session_upload(
        &operator.api,
        &transfer,
        &root.join("sync-b2"),
        &org,
        &profile,
        1,
        &data_b,
        (&s3.lease.id, &s3.lease.fencing_token),
        false,
    );
    assert_eq!(
        (stale.state, stale.error_code.as_deref()),
        (UploadState::Failed, Some("LEASE_TAKEN_OVER")),
        "{stale:?}"
    );
    assert_eq!(head(&owner), 1, "the stale upload did not overwrite");
    let kept = session_upload(
        &operator.api,
        &transfer,
        &root.join("sync-b3"),
        &org,
        &profile,
        0,
        &data_b,
        (&s3.lease.id, &s3.lease.fencing_token),
        true,
    );
    assert_eq!(kept.state, UploadState::Committed, "{kept:?}");
    assert_eq!(head(&owner), 1, "a recovery copy is never the head");
    let copies = raw(
        &owner,
        Method::Get,
        &format!("/v1/orgs/{org}/recovery-copies?limit=100"),
        None,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let ours = copies["items"]
        .as_array()
        .map(|i| {
            i.iter()
                .filter(|c| c["profile_id"] == json!(profile))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(ours, 1);
    report.push(
        "forced takeover: old heartbeat fenced (taken_over), stale upload refused (head still 1), copy kept as 1 recovery copy"
            .into(),
    );

    // ---- 5. Removed access: the operator's session ends at once and nothing more is accepted from them.
    let s4 = operator
        .api
        .open_session(&org, &profile, &key("open-"), &open_request(&operator))
        .unwrap_or_else(|e| panic!("{e}"));
    raw(
        &owner,
        Method::Delete,
        &format!("/v1/orgs/{org}/grants/{grant}"),
        None,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let after = operator
        .api
        .heartbeat(&org, &profile, &s4.lease.id, &s4.lease.fencing_token, None);
    assert!(
        matches!(&after, Err(ApiError::Fenced { state }) if state == "revoked")
            || matches!(&after, Err(e) if e.is_code("NOT_FOUND") || e.is_code("FORBIDDEN")),
        "{after:?}"
    );
    let reopen = operator
        .api
        .open_session(&org, &profile, &key("open-"), &open_request(&operator));
    assert!(
        matches!(&reopen, Err(e) if e.is_code("NOT_FOUND") || e.is_code("FORBIDDEN")),
        "{reopen:?}"
    );
    let late = session_upload(
        &operator.api,
        &transfer,
        &root.join("sync-b4"),
        &org,
        &profile,
        1,
        &data_b,
        (&s4.lease.id, &s4.lease.fencing_token),
        false,
    );
    assert_ne!(late.state, UploadState::Committed, "{late:?}");
    assert_eq!(head(&owner), 1);
    let current = raw(&owner, Method::Get, &format!("{prf}/leases/current"), None)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        current["lease"],
        Value::Null,
        "the revoked session no longer holds it"
    );
    report.push(
        "access removed: session ended (revoked), reopen and late upload refused, head still 1"
            .into(),
    );

    // ---- 6. The audit trail has the whole sequence.
    let audit = raw(
        &owner,
        Method::Get,
        &format!("/v1/orgs/{org}/audit-events?limit=100"),
        None,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let actions: Vec<String> = audit["items"]
        .as_array()
        .map(|i| {
            i.iter()
                .filter(|e| {
                    e["target_id"] == json!(profile) || e["details"]["profile_id"] == json!(profile)
                })
                .filter_map(|e| e["action"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    for needed in [
        "lease.acquired",
        "handoff.requested",
        "lease.released",
        "lease.taken_over",
        "lease.revoked",
    ] {
        assert!(
            actions.iter().any(|a| a == needed),
            "{needed} missing from {actions:?}"
        );
    }
    report.push(format!(
        "audit: {} events for the profile, including acquire, request, release, takeover and revocation",
        actions.len()
    ));

    for line in &report {
        println!("E2E-SESSIONS: {line}");
    }
}
