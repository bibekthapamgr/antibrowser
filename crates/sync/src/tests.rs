//! Engine tests against the in-memory server: round trip, network loss at every call (before and after the server
//! applied it), the app killed at every saved step, concurrent devices, and restores that must fail closed.

use crate::api::{ApiError, SnapshotInfo};
use crate::engine::{Engine, Outcome, Poll, RestoreChecks, Source, SyncError, new_upload};
use crate::fake::{FakeClient, FakeServer, When};
use crate::job::UploadState;
use crate::job::{Job, JobStore, MemoryJobs, RestoreJob, RestoreState, RestoreTarget, UploadJob};
use crate::portability::{self, Here, Portability};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

const ORG: &str = "org_01J9ZSEED0ACME000000000000";
const OTHER_ORG: &str = "org_01J9ZSEED0GLOBEX0000000000";
const PRF: &str = "prf_01J9ZSEED0A010000000000000";
const LOCAL: &str = "prf_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const PART: u64 = 64 * 1024;

fn quiet(_: &str, _: &'static str, _: u64, _: u64) {}

const POLL: Poll = Poll {
    interval: Duration::from_millis(1),
    max_wait: Duration::from_millis(20),
};

struct World {
    server: Arc<FakeServer>,
    a: FakeClient,
    _dir: tempfile::TempDir,
    profile: PathBuf,
    work: PathBuf,
    root: PathBuf,
    jobs: MemoryJobs,
}

fn write(path: &Path, bytes: &[u8]) {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).unwrap_or_else(|e| panic!("{e}"));
    }
    fs::write(path, bytes).unwrap_or_else(|e| panic!("{e}"));
}

fn random(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    getrandom::fill(&mut v).unwrap_or_else(|e| panic!("{e}"));
    v
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let root = dir.path().to_path_buf();
    let profile = root.join("profile/user-data");
    write(&profile.join("Default/Cookies"), b"cookie-db");
    write(
        &profile.join("Default/Local Storage/leveldb/000003.log"),
        b"local-storage",
    );
    // Incompressible, so the sealed file spans several 64 KiB parts.
    write(&profile.join("Default/IndexedDB/blob"), &random(200 * 1024));
    write(&profile.join("Default/Cache/data_0"), b"cache: excluded");
    write(&profile.join("SingletonLock"), b"lock: excluded");
    let server = FakeServer::new(PART);
    server.add_profile(ORG, PRF);
    let a = server.client("dev_A", &[ORG]);
    World {
        server,
        a,
        work: root.join("sync"),
        profile,
        root,
        _dir: dir,
        jobs: MemoryJobs::default(),
    }
}

fn source(p: &Path) -> Source<'_> {
    Source {
        user_data: p,
        settings_json: Some(br#"{"start_urls":["https://example.test/"]}"#),
        platform: "linux-x64",
        browser_version: "155.0.8059.39",
        app_version: "0.7.0",
    }
}

fn engine<'a>(
    client: &'a FakeClient,
    jobs: &'a dyn JobStore,
    work: &'a Path,
    cancel: &'a AtomicBool,
) -> Engine<'a> {
    Engine {
        api: client,
        objects: client,
        jobs,
        work_dir: work,
        cancel,
        progress: &quiet,
        poll: POLL,
    }
}

struct Checks {
    free: u64,
    browser: Option<&'static str>,
    device: &'static str,
}

const PLENTY: Checks = Checks {
    free: u64::MAX,
    browser: Some("155.0.8059.39"),
    device: "dev_A",
};

impl RestoreChecks for Checks {
    fn compatible(&self, s: &SnapshotInfo) -> Result<(), String> {
        let v = portability::classify(
            &s.platform,
            &s.browser_version,
            s.schema_version,
            s.device_id.as_deref(),
            &Here {
                platform: "linux-x64",
                device_id: Some(self.device),
                browser_version: self.browser,
            },
        );
        if v.portability == Portability::Unsupported {
            Err(v.reason.to_owned())
        } else {
            Ok(())
        }
    }
    fn free_space(&self, _: &Path) -> io::Result<u64> {
        Ok(self.free)
    }
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

fn expected(profile: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut t = tree(profile);
    t.retain(|k, _| !k.starts_with("Default/Cache/") && k != "SingletonLock");
    t
}

/// Uploads with no faults; returns the job.
fn upload(w: &World, client: &FakeClient, base: i64) -> UploadJob {
    let never = AtomicBool::new(false);
    let mut job = new_upload(LOCAL, ORG, PRF, base).unwrap_or_else(|e| panic!("{e}"));
    let e = engine(client, &w.jobs, &w.work, &never);
    let out = e.upload(&mut job, Some(&source(&w.profile)));
    assert_eq!(out, Ok(Outcome::Finished), "{job:?}");
    job
}

/// Restores the head (or `snapshot`) into a fresh folder; returns the job and the opened folder.
fn restore(
    w: &World,
    client: &FakeClient,
    snapshot: Option<&str>,
    checks: &Checks,
) -> (
    RestoreJob,
    Result<Option<crate::Opened>, SyncError>,
    PathBuf,
) {
    let never = AtomicBool::new(false);
    let mut job = RestoreJob::new(
        crate::job::random_id("sj_").unwrap_or_default(),
        ORG,
        PRF,
        LOCAL,
        RestoreTarget::Replace,
        snapshot,
    );
    let dest = w.root.join(format!("incoming-{}", job.id));
    let e = engine(client, &w.jobs, &w.work, &never);
    let r = e.restore(&mut job, &dest, checks);
    (job, r, dest)
}

fn assert_restorable(w: &World, version: i64, files: &BTreeMap<String, Vec<u8>>) {
    let (job, r, dest) = restore(w, &w.a, None, &PLENTY);
    let opened = r
        .unwrap_or_else(|e| panic!("{e}"))
        .unwrap_or_else(|| panic!("restore failed: {job:?}"));
    assert_eq!(opened.snapshot.version, version);
    assert_eq!(&tree(&dest.join("user-data")), files);
    let _ = fs::remove_dir_all(dest);
}

#[test]
fn same_device_round_trip() {
    let w = world();
    let job = upload(&w, &w.a, 0);
    assert_eq!(job.state, UploadState::Committed);
    assert_eq!(job.version, Some(1));
    assert!(job.fencing_token.is_none(), "lease released");
    assert_eq!(w.server.lease_holder(PRF), None);
    assert!(
        fs::read_dir(&w.work).map(|d| d.count()).unwrap_or(0) == 0,
        "no sealed file left behind"
    );
    let stored = w
        .server
        .object(&job.snapshot_id.clone().unwrap_or_default());
    let stored = stored.unwrap_or_default();
    assert!(
        !stored.windows(9).any(|x| x == b"cookie-db"),
        "only ciphertext is stored"
    );
    assert!(
        job.sealed.as_ref().is_some_and(|s| s.size > 3 * PART),
        "several parts"
    );

    let (rj, r, dest) = restore(&w, &w.a, None, &PLENTY);
    let opened = r
        .unwrap_or_else(|e| panic!("{e}"))
        .unwrap_or_else(|| panic!("{rj:?}"));
    assert_eq!(rj.state, RestoreState::Ready);
    assert_eq!(opened.snapshot.version, 1);
    assert_eq!(tree(&dest.join("user-data")), expected(&w.profile));
    let settings = opened
        .meta
        .get("settings.json")
        .cloned()
        .unwrap_or_default();
    assert_eq!(settings, br#"{"start_urls":["https://example.test/"]}"#);
    let meta: serde_json::Value =
        serde_json::from_slice(opened.meta.get("snapshot.json").map_or(&[][..], |v| v))
            .unwrap_or_default();
    assert_eq!(meta["snapshot_id"], opened.snapshot.id.as_str());
    assert_eq!(meta["base_version"], 0);
}

#[test]
fn network_lost_at_every_call_keeps_the_prior_snapshot_and_commits_once() {
    let calls = [
        "acquire_lease",
        "renew_lease",
        "init",
        "operation",
        "stored_parts",
        "part_urls",
        "put_part",
        "commit",
    ];
    for call in calls {
        for when in [When::Before, When::After] {
            let w = world();
            upload(&w, &w.a, 0);
            let v1 = expected(&w.profile);
            write(&w.profile.join("Default/Cookies"), b"cookie-db-v2");
            let v2 = expected(&w.profile);

            let never = AtomicBool::new(false);
            let mut job = new_upload(LOCAL, ORG, PRF, 1).unwrap_or_else(|e| panic!("{e}"));
            w.jobs.save(&Job::Upload(job.clone())).unwrap_or_default();
            w.server.fail(call, when);
            let first =
                engine(&w.a, &w.jobs, &w.work, &never).upload(&mut job, Some(&source(&w.profile)));
            if let Err(e) = &first {
                assert!(e.is_transient(), "{call} {when:?}: {e:?}");
                // Interrupted: the head is still version 1 and restores.
                assert_eq!(w.server.head(PRF).0, 1, "{call} {when:?}");
                assert_restorable(&w, 1, &v1);
            }
            // The app restarts and resumes from what it saved.
            let Some(Job::Upload(mut resumed)) = w.jobs.load(&job.id) else {
                panic!("job not saved: {call} {when:?} {first:?}");
            };
            let mut runs = 0;
            while !resumed.state.is_terminal() && runs < 5 {
                runs += 1;
                let _ = engine(&w.a, &w.jobs, &w.work, &never)
                    .upload(&mut resumed, Some(&source(&w.profile)));
            }
            assert_eq!(
                resumed.state,
                UploadState::Committed,
                "{call} {when:?}: {resumed:?}"
            );
            assert_eq!(resumed.version, Some(2));
            let versions: Vec<i64> = w.server.committed(PRF).iter().map(|c| c.0).collect();
            assert_eq!(
                versions,
                vec![1, 2],
                "{call} {when:?}: committed exactly once"
            );
            assert_restorable(&w, 2, &v2);
        }
    }
}

/// Fails the Nth save, as if the app were killed right before writing that step.
struct KillAt<'a> {
    inner: &'a MemoryJobs,
    left: Mutex<i64>,
}

impl JobStore for KillAt<'_> {
    fn save(&self, job: &Job) -> Result<(), String> {
        let mut left = self.left.lock().map_err(|_| "poisoned".to_owned())?;
        *left -= 1;
        if *left < 0 {
            return Err("killed".into());
        }
        self.inner.save(job)
    }
}

#[test]
fn app_killed_at_every_step_resumes_without_losing_or_duplicating_a_version() {
    let mut kill_at = 0;
    loop {
        let w = world();
        upload(&w, &w.a, 0);
        let v1 = expected(&w.profile);
        write(&w.profile.join("Default/Cookies"), b"cookie-db-v2");
        let never = AtomicBool::new(false);
        let mut job = new_upload(LOCAL, ORG, PRF, 1).unwrap_or_else(|e| panic!("{e}"));
        w.jobs.save(&Job::Upload(job.clone())).unwrap_or_default();
        let killing = KillAt {
            inner: &w.jobs,
            left: Mutex::new(kill_at),
        };
        let first =
            engine(&w.a, &killing, &w.work, &never).upload(&mut job, Some(&source(&w.profile)));
        if first.is_ok() {
            assert!(kill_at > 5, "the loop covered every save ({kill_at})");
            eprintln!("killed and resumed at each of {kill_at} saved steps");
            break;
        }
        assert_eq!(first, Err(SyncError::Store("killed".into())));
        // Killed before the server's commit: version 1 is the head; after it: version 2. Either restores.
        match w.server.head(PRF).0 {
            1 => assert_restorable(&w, 1, &v1),
            2 => assert_restorable(&w, 2, &expected(&w.profile)),
            other => panic!("kill at save {kill_at}: head {other}"),
        }
        // A sealing run killed mid-way leaves a partial file behind.
        if let Some(Job::Upload(saved)) = w.jobs.load(&job.id)
            && let Some(s) = &saved.snapshot_id
        {
            write(&w.work.join(format!("{s}.pbseal.part")), b"partial");
        }
        let Some(Job::Upload(mut resumed)) = w.jobs.load(&job.id) else {
            panic!("job not saved");
        };
        let mut runs = 0;
        while !resumed.state.is_terminal() && runs < 5 {
            runs += 1;
            let _ = engine(&w.a, &w.jobs, &w.work, &never)
                .upload(&mut resumed, Some(&source(&w.profile)));
        }
        assert_eq!(
            resumed.state,
            UploadState::Committed,
            "kill at {kill_at}: {resumed:?}"
        );
        let versions: Vec<i64> = w.server.committed(PRF).iter().map(|c| c.0).collect();
        assert_eq!(versions, vec![1, 2], "kill at save {kill_at}");
        kill_at += 1;
    }
}

#[test]
fn concurrent_devices_get_one_winner_and_one_conflict() {
    let w = world();
    let b = w.server.client("dev_B", &[ORG]);
    let never = AtomicBool::new(false);
    // A holds the lease mid-upload (its first part upload fails: offline).
    let mut ja = new_upload(LOCAL, ORG, PRF, 0).unwrap_or_else(|e| panic!("{e}"));
    w.server.fail("put_part", When::Before);
    let r = engine(&w.a, &w.jobs, &w.work, &never).upload(&mut ja, Some(&source(&w.profile)));
    assert_eq!(r, Err(SyncError::StorageOffline));
    // B cannot start while A holds the lease.
    let work_b = w.root.join("sync-b");
    let mut jb =
        new_upload("prf_01HYYYYYYYYYYYYYYYYYYYYYYY", ORG, PRF, 0).unwrap_or_else(|e| panic!("{e}"));
    let r = engine(&b, &w.jobs, &work_b, &never).upload(&mut jb, Some(&source(&w.profile)));
    assert_eq!(r, Err(SyncError::Api(ApiError::LeaseHeld)));
    // A finishes; B, based on the same version 0, gets a conflict, never an overwrite.
    let r = engine(&w.a, &w.jobs, &w.work, &never).upload(&mut ja, Some(&source(&w.profile)));
    assert_eq!(r, Ok(Outcome::Finished));
    assert_eq!(ja.state, UploadState::Committed);
    let r = engine(&b, &w.jobs, &work_b, &never).upload(&mut jb, Some(&source(&w.profile)));
    assert_eq!(r, Ok(Outcome::Finished));
    assert_eq!(jb.state, UploadState::Conflict);
    assert_eq!(jb.head_version, Some(1));
    assert_eq!(w.server.committed(PRF).len(), 1);
    assert_eq!(w.server.lease_holder(PRF), None, "B released its lease");
}

#[test]
fn a_lease_lost_mid_upload_restarts_and_then_conflicts_instead_of_overwriting() {
    let w = world();
    let b = w.server.client("dev_B", &[ORG]);
    let never = AtomicBool::new(false);
    let mut ja = new_upload(LOCAL, ORG, PRF, 0).unwrap_or_else(|e| panic!("{e}"));
    w.server.fail("put_part", When::Before);
    let _ = engine(&w.a, &w.jobs, &w.work, &never).upload(&mut ja, Some(&source(&w.profile)));
    assert_eq!(ja.state, UploadState::Uploading);
    // A's lease expires (computer asleep); B takes it and commits version 1.
    w.server.expire_lease(PRF);
    let work_b = w.root.join("sync-b");
    let mut jb =
        new_upload("prf_01HYYYYYYYYYYYYYYYYYYYYYYY", ORG, PRF, 0).unwrap_or_else(|e| panic!("{e}"));
    let r = engine(&b, &w.jobs, &work_b, &never).upload(&mut jb, Some(&source(&w.profile)));
    assert_eq!(
        (r, jb.state),
        (Ok(Outcome::Finished), UploadState::Committed)
    );
    // A wakes up: its lease is gone, so its upload restarts, and the new init finds version 1.
    let r = engine(&w.a, &w.jobs, &w.work, &never).upload(&mut ja, Some(&source(&w.profile)));
    assert_eq!(r, Ok(Outcome::Finished));
    assert_eq!(ja.state, UploadState::Conflict, "{ja:?}");
    assert_eq!(ja.head_version, Some(1));
    assert_eq!(w.server.committed(PRF).len(), 1);
}

#[test]
fn verification_that_takes_long_is_waited_for_later() {
    let w = world();
    w.server
        .auto_verify
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let never = AtomicBool::new(false);
    let mut job = new_upload(LOCAL, ORG, PRF, 0).unwrap_or_else(|e| panic!("{e}"));
    let e = engine(&w.a, &w.jobs, &w.work, &never);
    assert_eq!(
        e.upload(&mut job, Some(&source(&w.profile))),
        Ok(Outcome::Waiting)
    );
    assert_eq!(job.state, UploadState::Verifying);
    w.server.verify_all();
    // No profile needed any more: everything is uploaded.
    assert_eq!(e.upload(&mut job, None), Ok(Outcome::Finished));
    assert_eq!(job.state, UploadState::Committed);
}

#[test]
fn a_failed_verification_restarts_with_a_fresh_snapshot() {
    let w = world();
    w.server
        .auto_verify
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let never = AtomicBool::new(false);
    let mut job = new_upload(LOCAL, ORG, PRF, 0).unwrap_or_else(|e| panic!("{e}"));
    let e = engine(&w.a, &w.jobs, &w.work, &never);
    assert_eq!(
        e.upload(&mut job, Some(&source(&w.profile))),
        Ok(Outcome::Waiting)
    );
    let first = job.snapshot_id.clone().unwrap_or_default();
    // Storage corrupted the object before the worker checked it.
    let mut bytes = w.server.object(&first).unwrap_or_default();
    let n = bytes.len();
    bytes[n - 1] ^= 1;
    w.server.replace_object(&first, bytes);
    w.server.verify_all();
    assert_eq!(
        w.server.snapshot_state(&first),
        Some(("failed", Some("DIGEST_MISMATCH".into())))
    );
    w.server
        .auto_verify
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // Resealing needs the closed profile; without it the job waits.
    assert_eq!(e.upload(&mut job, None), Err(SyncError::NeedsProfile));
    assert_eq!(
        e.upload(&mut job, Some(&source(&w.profile))),
        Ok(Outcome::Finished)
    );
    assert_eq!(job.state, UploadState::Committed);
    assert_eq!(job.restarts, 1);
    assert_ne!(job.snapshot_id.as_deref(), Some(first.as_str()));
}

#[test]
fn canceling_an_upload_keeps_the_last_committed_version() {
    let w = world();
    upload(&w, &w.a, 0);
    let never = AtomicBool::new(false);
    let mut job = new_upload(LOCAL, ORG, PRF, 1).unwrap_or_else(|e| panic!("{e}"));
    w.server.fail("put_part", When::Before);
    let e = engine(&w.a, &w.jobs, &w.work, &never);
    let _ = e.upload(&mut job, Some(&source(&w.profile)));
    let snap = job.snapshot_id.clone().unwrap_or_default();
    e.cancel_upload(&mut job)
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(job.state, UploadState::Canceled);
    assert_eq!(
        w.server.snapshot_state(&snap).map(|s| s.0),
        Some("canceled")
    );
    assert_eq!(w.server.lease_holder(PRF), None);
    assert_eq!(w.server.head(PRF).0, 1);
    // Canceling while sealing (the cancel flag) stops before anything is uploaded.
    let cancel = AtomicBool::new(true);
    let mut job = new_upload(LOCAL, ORG, PRF, 1).unwrap_or_else(|e| panic!("{e}"));
    let r = engine(&w.a, &w.jobs, &w.work, &cancel).upload(&mut job, Some(&source(&w.profile)));
    assert_eq!(r, Err(SyncError::Cancelled));
}

#[test]
fn a_download_cut_off_resumes_where_it_stopped() {
    let w = world();
    upload(&w, &w.a, 0);
    w.server.fail("download", When::Before);
    let never = AtomicBool::new(false);
    let mut job = RestoreJob::new("sj_r".into(), ORG, PRF, LOCAL, RestoreTarget::Replace, None);
    let dest = w.root.join("incoming");
    let e = engine(&w.a, &w.jobs, &w.work, &never);
    assert_eq!(
        e.restore(&mut job, &dest, &PLENTY),
        Err(SyncError::StorageOffline)
    );
    assert_eq!(job.state, RestoreState::Downloading);
    let half = job.downloaded;
    assert!(half > 0);
    assert!(!dest.exists(), "nothing unpacked from a partial download");
    let Some(Job::Restore(mut resumed)) = w.jobs.load("sj_r") else {
        panic!("not saved");
    };
    let opened = e.restore(&mut resumed, &dest, &PLENTY);
    assert!(matches!(opened, Ok(Some(_))), "{resumed:?}");
    assert_eq!(tree(&dest.join("user-data")), expected(&w.profile));
    e.finish_restore(&mut resumed)
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(resumed.state, RestoreState::Done);
    assert!(
        !e.download_path(&resumed.snapshot.clone().map(|s| s.id).unwrap_or_default())
            .exists()
    );
}

#[test]
fn restores_fail_closed_for_another_org_substitution_and_tampering() {
    let w = world();
    let first = upload(&w, &w.a, 0);
    write(&w.profile.join("Default/Cookies"), b"cookie-db-v2");
    let second = upload(&w, &w.a, 1);
    let s1 = first.snapshot_id.clone().unwrap_or_default();
    let s2 = second.snapshot_id.clone().unwrap_or_default();

    // Another organization's member: the profile does not exist for them.
    let outsider = w.server.client("dev_X", &[OTHER_ORG]);
    let (job, r, dest) = restore(&w, &outsider, None, &PLENTY);
    assert_eq!((r, job.state), (Ok(None), RestoreState::Failed));
    assert_eq!(job.error_code.as_deref(), Some("NOT_FOUND"));
    assert!(!dest.exists());

    // Object substitution: version 2's stored object replaced by version 1's (a valid sealed file).
    let original = w.server.object(&s2).unwrap_or_default();
    let other = w.server.object(&s1).unwrap_or_default();
    w.server.replace_object(&s2, other.clone());
    let (job, _, dest) = restore(&w, &w.a, None, &PLENTY);
    assert_eq!(job.error_code.as_deref(), Some("DIGEST_MISMATCH"));
    assert!(!dest.exists());

    // ...and the manifest tampered to match it: the header binds the file to its own snapshot id.
    let (d1, n1) = pb_seal::format::digest_reader(&other[..]).unwrap_or_default();
    w.server.set_manifest(&s2, &d1, n1);
    let (job, _, dest) = restore(&w, &w.a, None, &PLENTY);
    assert_eq!(job.error_code.as_deref(), Some("SEAL_WRONG_BINDING"));
    assert!(!dest.exists(), "nothing kept from a refused file");

    // One flipped byte with a matching manifest digest: authentication fails.
    let mut flipped = original.clone();
    let n = flipped.len();
    flipped[n - 100] ^= 0x40;
    let (d2, n2) = pb_seal::format::digest_reader(&flipped[..]).unwrap_or_default();
    w.server.replace_object(&s2, flipped);
    w.server.set_manifest(&s2, &d2, n2);
    let (job, _, dest) = restore(&w, &w.a, None, &PLENTY);
    assert_eq!(
        job.error_code.as_deref(),
        Some("SEAL_AUTHENTICATION_FAILED")
    );
    assert!(!dest.exists());

    // The untouched version 1 still restores.
    let (job, r, _) = restore(&w, &w.a, Some(&s1), &PLENTY);
    assert!(matches!(r, Ok(Some(_))), "{job:?}");
}

#[test]
fn restores_check_space_and_browser_version_before_downloading() {
    let w = world();
    upload(&w, &w.a, 0);
    let full = Checks {
        free: 1024,
        ..PLENTY
    };
    let (job, _, dest) = restore(&w, &w.a, None, &full);
    assert_eq!(job.error_code.as_deref(), Some("LOW_DISK_SPACE"));
    assert!(!dest.exists());
    let old = Checks {
        browser: Some("154.0.1.1"),
        ..PLENTY
    };
    let (job, _, _) = restore(&w, &w.a, None, &old);
    assert_eq!(job.error_code.as_deref(), Some("RUNTIME_TOO_OLD"));
    assert!(
        !w.server.calls().contains(&"download"),
        "nothing downloaded"
    );
    // Another device restores it (sign-in required, but supported).
    let b = w.server.client("dev_B", &[ORG]);
    let other = Checks {
        device: "dev_B",
        ..PLENTY
    };
    let (job, r, _) = restore(&w, &b, None, &other);
    assert!(matches!(r, Ok(Some(_))), "{job:?}");
}
