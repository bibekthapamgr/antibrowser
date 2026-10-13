//! An in-memory control plane and object store with the real API's rules (leases and fencing, idempotent init,
//! version compare-and-swap, server-side verification of size, header and SHA-256) and fault injection: any call can
//! fail before it reaches the server or after the server applied it (the answer is lost), which is how the tests
//! "kill the network" at every step. Used by this crate's tests and by the desktop's tests (feature `testing`).

use crate::api::{
    ApiError, CommitRequest, InitRequest, InitResult, ObjectError, Objects, Operation, PartUrl,
    RestorePlan, SnapshotInfo, StoredPart, SyncApi,
};
use pb_seal::{Kind, SealKey};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    /// The request never reaches the server.
    Before,
    /// The server applies the request, then the answer is lost.
    After,
}

#[derive(Clone, Debug)]
struct Snap {
    org: String,
    profile: String,
    base: i64,
    state: &'static str,
    error: Option<String>,
    fencing: u64,
    device: String,
    key: [u8; 32],
    key_version: String,
    version: Option<i64>,
    digest: Option<String>,
    size: u64,
    plaintext: u64,
    platform: String,
    browser: String,
    op_id: String,
    init_key: String,
    init_digest: String,
    parts: BTreeMap<u32, Vec<u8>>,
}

#[derive(Clone, Debug)]
struct Lease {
    fencing: u64,
    device: String,
    live: bool,
}

#[derive(Default)]
struct State {
    /// profile id → (org id, head version, head snapshot)
    profiles: HashMap<String, (String, i64, Option<String>)>,
    leases: HashMap<String, Lease>,
    lease_keys: HashMap<String, u64>,
    next_fencing: u64,
    snaps: HashMap<String, Snap>,
    objects: HashMap<String, Vec<u8>>,
    /// signed URL token → (snapshot, part number or 0 for the whole object)
    urls: HashMap<String, (String, u32)>,
    seq: u64,
    faults: Vec<(&'static str, When)>,
    calls: Vec<&'static str>,
}

pub struct FakeServer {
    state: Mutex<State>,
    pub part_size: u64,
    pub key_version: String,
    /// When false, operations stay `verifying` until [`FakeServer::verify_all`] runs (a slow worker).
    pub auto_verify: AtomicBool,
}

fn ulid_like(prefix: &str, n: u64) -> String {
    format!(
        "{prefix}_{:0>26}",
        format!("{n:X}").replace(['I', 'L', 'O', 'U'], "0")
    )
}

impl FakeServer {
    pub fn new(part_size: u64) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                next_fencing: 100,
                ..State::default()
            }),
            part_size,
            key_version: ulid_like("okv", 1),
            auto_verify: AtomicBool::new(true),
        })
    }

    fn st(&self) -> MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn add_profile(&self, org: &str, profile: &str) {
        self.st()
            .profiles
            .insert(profile.to_owned(), (org.to_owned(), 0, None));
    }

    /// The next call named `call` fails `when`.
    pub fn fail(&self, call: &'static str, when: When) {
        self.st().faults.push((call, when));
    }

    pub fn calls(&self) -> Vec<&'static str> {
        self.st().calls.clone()
    }

    pub fn head(&self, profile: &str) -> (i64, Option<String>) {
        self.st()
            .profiles
            .get(profile)
            .map(|p| (p.1, p.2.clone()))
            .unwrap_or((0, None))
    }

    /// Committed snapshots of a profile (oldest first).
    pub fn committed(&self, profile: &str) -> Vec<(i64, String)> {
        let st = self.st();
        let mut v: Vec<(i64, String)> = st
            .snaps
            .iter()
            .filter(|(_, s)| s.profile == profile && s.state == "committed")
            .map(|(id, s)| (s.version.unwrap_or(0), id.clone()))
            .collect();
        v.sort();
        v
    }

    pub fn snapshot_state(&self, snapshot: &str) -> Option<(&'static str, Option<String>)> {
        self.st()
            .snaps
            .get(snapshot)
            .map(|s| (s.state, s.error.clone()))
    }

    /// Ends a lease as if it expired (another device may take it).
    pub fn expire_lease(&self, profile: &str) {
        if let Some(l) = self.st().leases.get_mut(profile) {
            l.live = false;
        }
    }

    pub fn lease_holder(&self, profile: &str) -> Option<String> {
        self.st()
            .leases
            .get(profile)
            .filter(|l| l.live)
            .map(|l| l.device.clone())
    }

    /// Makes every signed URL issued so far expire.
    pub fn expire_urls(&self) {
        self.st().urls.clear();
    }

    pub fn object(&self, snapshot: &str) -> Option<Vec<u8>> {
        self.st().objects.get(snapshot).cloned()
    }

    /// Replaces a stored object (substitution attack or storage corruption).
    pub fn replace_object(&self, snapshot: &str, bytes: Vec<u8>) {
        self.st().objects.insert(snapshot.to_owned(), bytes);
    }

    /// Changes a manifest's recorded digest and size (manifest tampering).
    pub fn set_manifest(&self, snapshot: &str, digest: &str, size: u64) {
        if let Some(s) = self.st().snaps.get_mut(snapshot) {
            s.digest = Some(digest.to_owned());
            s.size = size;
        }
    }

    /// Runs the verification worker over every operation waiting for it.
    pub fn verify_all(&self) {
        let mut st = self.st();
        let ids: Vec<String> = st
            .snaps
            .iter()
            .filter(|(_, s)| s.state == "verifying")
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            verify(&mut st, &id);
        }
    }

    /// A client for one device of one user, with access to `orgs`.
    pub fn client(self: &Arc<Self>, device: &str, orgs: &[&str]) -> FakeClient {
        FakeClient {
            server: self.clone(),
            device: device.to_owned(),
            orgs: orgs.iter().map(|o| (*o).to_owned()).collect(),
        }
    }
}

fn verify(st: &mut State, id: &str) {
    let Some(s) = st.snaps.get(id).cloned() else {
        return;
    };
    let fail = |st: &mut State, code: &str| {
        if let Some(s) = st.snaps.get_mut(id) {
            s.state = "failed";
            s.error = Some(code.to_owned());
        }
        st.objects.remove(id);
    };
    let Some(bytes) = st.objects.get(id).cloned() else {
        return fail(st, "OBJECT_MISSING");
    };
    if bytes.len() as u64 != s.size {
        return fail(st, "SIZE_MISMATCH");
    }
    let header = match pb_seal::format::read_header(&mut &bytes[..]) {
        Ok((h, _)) => h,
        Err(_) => return fail(st, "HEADER_INVALID"),
    };
    if header.kind != Kind::OrgSnapshot
        || header.org_id.as_deref() != Some(s.org.as_str())
        || header.profile_id != s.profile
        || header.object_id != id
        || header.key_version != s.key_version
        || header.schema_version != 1
    {
        return fail(st, "HEADER_MISMATCH");
    }
    let digest = pb_seal::format::digest_reader(&bytes[..])
        .map(|d| d.0)
        .unwrap_or_default();
    if Some(digest) != s.digest {
        return fail(st, "DIGEST_MISMATCH");
    }
    let lease_ok = st
        .leases
        .get(&s.profile)
        .is_some_and(|l| l.live && l.fencing == s.fencing);
    if !lease_ok {
        return fail(st, "FENCING_TOKEN_STALE");
    }
    let Some(p) = st.profiles.get_mut(&s.profile) else {
        return fail(st, "NOT_FOUND");
    };
    if p.1 != s.base {
        return fail(st, "VERSION_CONFLICT");
    }
    p.1 += 1;
    p.2 = Some(id.to_owned());
    let version = p.1;
    if let Some(s) = st.snaps.get_mut(id) {
        s.state = "committed";
        s.version = Some(version);
    }
}

fn code(status: u16, c: &str) -> ApiError {
    ApiError::Code {
        status,
        code: c.to_owned(),
    }
}

pub struct FakeClient {
    pub server: Arc<FakeServer>,
    pub device: String,
    orgs: Vec<String>,
}

impl FakeClient {
    fn enter(&self, call: &'static str) -> Result<MutexGuard<'_, State>, ApiError> {
        let mut st = self.server.st();
        st.calls.push(call);
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == call && *w == When::Before)
        {
            st.faults.remove(i);
            return Err(ApiError::Offline);
        }
        Ok(st)
    }

    fn leave(st: &mut State, call: &'static str) -> Result<(), ApiError> {
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == call && *w == When::After)
        {
            st.faults.remove(i);
            return Err(ApiError::Offline);
        }
        Ok(())
    }

    /// Tenant check: a profile of another organization is "not found" (never "forbidden").
    fn profile(&self, st: &State, org: &str, profile: &str) -> Result<(), ApiError> {
        match st.profiles.get(profile) {
            Some((o, _, _)) if o == org && self.orgs.iter().any(|x| x == org) => Ok(()),
            _ => Err(code(404, "NOT_FOUND")),
        }
    }

    fn require_lease(&self, st: &State, profile: &str, fencing: &str) -> Result<(), ApiError> {
        match st.leases.get(profile) {
            Some(l) if l.live && l.fencing.to_string() == fencing && l.device == self.device => {
                Ok(())
            }
            _ => Err(ApiError::LeaseLost),
        }
    }

    fn own_snap<'s>(
        &self,
        st: &'s mut State,
        org: &str,
        profile: &str,
        snapshot: &str,
    ) -> Result<&'s mut Snap, ApiError> {
        match st.snaps.get_mut(snapshot) {
            Some(s) if s.org == org && s.profile == profile && s.device == self.device => Ok(s),
            _ => Err(code(404, "NOT_FOUND")),
        }
    }

    fn token(st: &mut State, snapshot: &str, part: u32) -> String {
        st.seq += 1;
        let t = format!("t{}", st.seq);
        st.urls.insert(t.clone(), (snapshot.to_owned(), part));
        format!("fake://storage/{t}")
    }
}

impl SyncApi for FakeClient {
    fn acquire_lease(&self, org: &str, profile: &str, key: &str) -> Result<String, ApiError> {
        let mut st = self.enter("acquire_lease")?;
        self.profile(&st, org, profile)?;
        let replay_key = format!("{org}/{key}");
        if let Some(f) = st.lease_keys.get(&replay_key) {
            let f = *f;
            Self::leave(&mut st, "acquire_lease")?;
            return Ok(f.to_string());
        }
        if let Some(l) = st.leases.get(profile)
            && l.live
            && l.device != self.device
        {
            return Err(ApiError::LeaseHeld);
        }
        st.next_fencing += 1;
        let fencing = st.next_fencing;
        st.leases.insert(
            profile.to_owned(),
            Lease {
                fencing,
                device: self.device.clone(),
                live: true,
            },
        );
        st.lease_keys.insert(replay_key, fencing);
        Self::leave(&mut st, "acquire_lease")?;
        Ok(fencing.to_string())
    }

    fn renew_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError> {
        let mut st = self.enter("renew_lease")?;
        self.profile(&st, org, profile)?;
        self.require_lease(&st, profile, fencing)?;
        Self::leave(&mut st, "renew_lease")
    }

    fn release_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError> {
        let mut st = self.enter("release_lease")?;
        self.profile(&st, org, profile)?;
        if let Some(l) = st.leases.get_mut(profile)
            && l.fencing.to_string() == fencing
            && l.device == self.device
        {
            l.live = false;
        }
        Self::leave(&mut st, "release_lease")
    }

    fn init(
        &self,
        org: &str,
        profile: &str,
        key: &str,
        req: &InitRequest,
    ) -> Result<InitResult, ApiError> {
        let mut st = self.enter("init")?;
        self.profile(&st, org, profile)?;
        let digest = format!(
            "{}|{}|{}|{}|{}",
            profile, req.base_version, req.fencing_token, req.platform, req.browser_version
        );
        let replay = st
            .snaps
            .iter()
            .find(|(_, s)| s.org == org && s.init_key == key)
            .map(|(id, s)| (id.clone(), s.clone()));
        let (id, snap) = if let Some((id, s)) = replay {
            if s.init_digest != digest {
                return Err(code(409, "IDEMPOTENCY_KEY_REUSED"));
            }
            (id, s)
        } else {
            self.require_lease(&st, profile, &req.fencing_token)?;
            let head = st.profiles.get(profile).map(|p| p.1).unwrap_or(0);
            if head != req.base_version {
                return Err(ApiError::Conflict { head_version: head });
            }
            st.seq += 1;
            let id = ulid_like("snp", st.seq);
            let op_id = ulid_like("syn", st.seq);
            let key_bytes = {
                let mut k = [0u8; 32];
                getrandom::fill(&mut k).map_err(|_| code(500, "INTERNAL"))?;
                k
            };
            let s = Snap {
                org: org.to_owned(),
                profile: profile.to_owned(),
                base: req.base_version,
                state: "uploading",
                error: None,
                fencing: req.fencing_token.parse().unwrap_or(0),
                device: self.device.clone(),
                key: key_bytes,
                key_version: self.server.key_version.clone(),
                version: None,
                digest: None,
                size: 0,
                plaintext: 0,
                platform: req.platform.clone(),
                browser: req.browser_version.clone(),
                op_id,
                init_key: key.to_owned(),
                init_digest: digest,
                parts: BTreeMap::new(),
            };
            st.snaps.insert(id.clone(), s.clone());
            (id, s)
        };
        Self::leave(&mut st, "init")?;
        Ok(InitResult {
            operation_id: snap.op_id.clone(),
            snapshot_id: id,
            org_id: org.to_owned(),
            profile_id: profile.to_owned(),
            key_version: snap.key_version.clone(),
            schema_version: 1,
            data_key: SealKey::from_bytes(snap.key),
            part_size: self.server.part_size,
            max_parts: 10_000,
            max_bytes: 4 << 30,
        })
    }

    fn part_urls(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        parts: &[u32],
    ) -> Result<Vec<PartUrl>, ApiError> {
        let mut st = self.enter("part_urls")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?.clone();
        if s.state != "uploading" {
            return Err(code(409, "SYNC_STATE_CONFLICT"));
        }
        self.require_lease(&st, profile, &s.fencing.to_string())?;
        let urls = parts
            .iter()
            .map(|n| PartUrl {
                part_number: *n,
                url: Self::token(&mut st, snapshot, *n),
            })
            .collect();
        Self::leave(&mut st, "part_urls")?;
        Ok(urls)
    }

    fn stored_parts(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
    ) -> Result<Vec<StoredPart>, ApiError> {
        let mut st = self.enter("stored_parts")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?;
        let parts = if s.state == "uploading" {
            s.parts
                .iter()
                .map(|(n, b)| StoredPart {
                    part_number: *n,
                    size: b.len() as u64,
                    etag: etag(b),
                })
                .collect()
        } else {
            vec![]
        };
        Self::leave(&mut st, "stored_parts")?;
        Ok(parts)
    }

    fn commit(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        req: &CommitRequest,
    ) -> Result<Operation, ApiError> {
        let mut st = self.enter("commit")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?.clone();
        if s.state != "uploading" {
            if s.digest.as_deref().is_some_and(|d| d != req.digest) {
                return Err(code(409, "SYNC_STATE_CONFLICT"));
            }
            Self::leave(&mut st, "commit")?;
            return Ok(op_of(&s));
        }
        if req.fencing_token != s.fencing.to_string() {
            return Err(ApiError::LeaseLost);
        }
        self.require_lease(&st, profile, &req.fencing_token)?;
        let head = st.profiles.get(profile).map(|p| p.1).unwrap_or(0);
        if head != s.base {
            if let Some(m) = st.snaps.get_mut(snapshot) {
                m.state = "failed";
                m.error = Some("VERSION_CONFLICT".into());
            }
            return Err(ApiError::Conflict { head_version: head });
        }
        let count = req.ciphertext_size.div_ceil(self.server.part_size).max(1) as usize;
        let mut declared: Vec<_> = req.parts.clone();
        declared.sort_by_key(|p| p.part_number);
        if declared.len() != count
            || declared
                .iter()
                .enumerate()
                .any(|(i, p)| p.part_number as usize != i + 1)
        {
            return Err(code(400, "UPLOAD_INCOMPLETE"));
        }
        let mut object = Vec::new();
        for (i, p) in declared.iter().enumerate() {
            let Some(b) = s.parts.get(&p.part_number) else {
                return Err(code(400, "UPLOAD_INCOMPLETE"));
            };
            if etag(b) != p.etag || (i + 1 < count && b.len() as u64 != self.server.part_size) {
                return Err(code(400, "UPLOAD_INCOMPLETE"));
            }
            object.extend_from_slice(b);
        }
        if object.len() as u64 != req.ciphertext_size {
            return Err(code(400, "UPLOAD_INCOMPLETE"));
        }
        st.objects.insert(snapshot.to_owned(), object);
        let m = st
            .snaps
            .get_mut(snapshot)
            .ok_or_else(|| code(404, "NOT_FOUND"))?;
        m.state = "verifying";
        m.digest = Some(req.digest.clone());
        m.size = req.ciphertext_size;
        m.plaintext = req.plaintext_size;
        m.parts.clear();
        let view = op_of(m);
        Self::leave(&mut st, "commit")?;
        Ok(view)
    }

    fn cancel(&self, org: &str, profile: &str, snapshot: &str) -> Result<(), ApiError> {
        let mut st = self.enter("cancel")?;
        self.profile(&st, org, profile)?;
        let s = self.own_snap(&mut st, org, profile, snapshot)?;
        if s.state == "uploading" {
            s.state = "canceled";
            s.error = Some("CANCELED".into());
            s.parts.clear();
        }
        Self::leave(&mut st, "cancel")
    }

    fn operation(&self, org: &str, operation: &str) -> Result<Operation, ApiError> {
        let mut st = self.enter("operation")?;
        let Some(id) = st
            .snaps
            .iter()
            .find(|(_, s)| s.op_id == operation && s.org == org)
            .map(|(id, _)| id.clone())
        else {
            return Err(code(404, "NOT_FOUND"));
        };
        if !self.orgs.iter().any(|o| o == org) {
            return Err(code(404, "NOT_FOUND"));
        }
        if self.server.auto_verify.load(Ordering::Relaxed)
            && st.snaps.get(&id).is_some_and(|s| s.state == "verifying")
        {
            verify(&mut st, &id);
        }
        let view = st
            .snaps
            .get(&id)
            .map(op_of)
            .ok_or_else(|| code(404, "NOT_FOUND"))?;
        Self::leave(&mut st, "operation")?;
        Ok(view)
    }

    fn restore_plan(
        &self,
        org: &str,
        profile: &str,
        snapshot: Option<&str>,
    ) -> Result<RestorePlan, ApiError> {
        let mut st = self.enter("restore_plan")?;
        self.profile(&st, org, profile)?;
        let head = st.profiles.get(profile).cloned().unwrap_or_default();
        let Some(id) = snapshot.map(str::to_owned).or(head.2.clone()) else {
            return Err(code(404, "NOT_FOUND"));
        };
        let s = match st.snaps.get(&id) {
            Some(s) if s.profile == profile && s.org == org && s.state == "committed" => s.clone(),
            _ => return Err(code(404, "NOT_FOUND")),
        };
        let url = Self::token(&mut st, &id, 0);
        Self::leave(&mut st, "restore_plan")?;
        Ok(RestorePlan {
            snapshot: SnapshotInfo {
                id: id.clone(),
                version: s.version.unwrap_or(0),
                digest: s.digest.clone().unwrap_or_default(),
                ciphertext_size: s.size,
                plaintext_size: s.plaintext,
                platform: s.platform.clone(),
                browser_version: s.browser.clone(),
                schema_version: 1,
                device_id: Some(s.device.clone()),
                committed_at: None,
            },
            head_version: head.1,
            download_url: url,
            org_id: org.to_owned(),
            profile_id: profile.to_owned(),
            key_version: s.key_version.clone(),
            data_key: SealKey::from_bytes(s.key),
        })
    }
}

fn op_of(s: &Snap) -> Operation {
    Operation {
        id: s.op_id.clone(),
        state: s.state.to_owned(),
        version: s.version,
        error_code: s.error.clone(),
    }
}

fn etag(bytes: &[u8]) -> String {
    pb_seal::format::digest_reader(bytes)
        .map(|d| d.0[..32].to_owned())
        .unwrap_or_default()
}

impl Objects for FakeClient {
    fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, ObjectError> {
        let mut st = self.server.st();
        st.calls.push("put_part");
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == "put_part" && *w == When::Before)
        {
            st.faults.remove(i);
            return Err(ObjectError::Offline);
        }
        let token = url.strip_prefix("fake://storage/").unwrap_or_default();
        let Some((snapshot, part)) = st.urls.get(token).cloned() else {
            return Err(ObjectError::Expired);
        };
        if part == 0 {
            return Err(ObjectError::Refused("403".into()));
        }
        match st.snaps.get_mut(&snapshot) {
            Some(s) if s.state == "uploading" => {
                s.parts.insert(part, bytes.to_vec());
            }
            _ => return Err(ObjectError::Refused("404".into())),
        }
        if let Some(i) = st
            .faults
            .iter()
            .position(|(c, w)| *c == "put_part" && *w == When::After)
        {
            st.faults.remove(i);
            return Err(ObjectError::Offline);
        }
        Ok(etag(bytes))
    }

    fn download(
        &self,
        url: &str,
        start: u64,
        out: &mut dyn Write,
        _restart: &mut dyn FnMut() -> io::Result<()>,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64, ObjectError> {
        let (bytes, cut) = {
            let mut st = self.server.st();
            st.calls.push("download");
            let token = url.strip_prefix("fake://storage/").unwrap_or_default();
            let Some((snapshot, 0)) = st.urls.get(token).cloned() else {
                return Err(ObjectError::Expired);
            };
            let Some(bytes) = st.objects.get(&snapshot).cloned() else {
                return Err(ObjectError::Refused("404".into()));
            };
            // "download" Before: the connection drops halfway through.
            let cut = st
                .faults
                .iter()
                .position(|(c, _)| *c == "download")
                .map(|i| st.faults.remove(i));
            (bytes, cut.is_some())
        };
        let start = start.min(bytes.len() as u64) as usize;
        let end = if cut {
            start + (bytes.len() - start) / 2
        } else {
            bytes.len()
        };
        let mut offset = start;
        for chunk in bytes[start..end].chunks(4096) {
            if cancel.load(Ordering::Relaxed) {
                return Err(ObjectError::Cancelled);
            }
            out.write_all(chunk).map_err(|_| ObjectError::Local)?;
            offset += chunk.len();
            progress(offset as u64);
        }
        if cut {
            return Err(ObjectError::Offline);
        }
        Ok(offset as u64)
    }
}
