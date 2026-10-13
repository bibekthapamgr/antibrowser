//! The snapshot API over HTTP (milestone 07): request paths, bodies and response parsing in one place, shared by the
//! desktop (through its signed-in session) and the end-to-end tests (with a bearer token). Ids are checked against
//! their grammar before they become part of a path.

use crate::api::{
    ApiError, Beat, CommitRequest, Holder, InitRequest, InitResult, LeaseInfo, OpenRequest,
    Operation, PartUrl, RestorePlan, SessionApi, SessionOpened, SessionOutcome, SnapshotInfo,
    StoredPart, SyncApi,
};
use pb_cloud::{Http, HttpError, Method};
use pb_seal::SealKey;
use serde_json::{Value, json};
use url::Url;

/// Leases taken for an upload last this long and are renewed while it runs.
pub const LEASE_SECONDS: u32 = 600;

/// Makes one authenticated JSON request: `Ok(body)` for a 2xx answer, otherwise the mapped [`ApiError`].
pub trait Transport: Send + Sync {
    fn call(
        &self,
        method: Method,
        path: &str,
        idempotency_key: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value, ApiError>;
}

/// Maps an API error answer (`{ code, message, safe_details }`) to what the engine distinguishes.
pub fn map_error(status: u16, body: &Value) -> ApiError {
    let code = body.get("code").and_then(Value::as_str).unwrap_or("");
    match (status, code) {
        (401, _) => ApiError::SignedOut,
        (_, "VERSION_CONFLICT") => ApiError::Conflict {
            head_version: body
                .pointer("/safe_details/head_version")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        },
        (_, "LEASE_HELD" | "LEASE_UNCERTAIN") => {
            let d = body.get("safe_details");
            let text = |k: &str| {
                d.and_then(|d| d.get(k))
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(120).collect::<String>())
            };
            ApiError::LeaseHeld(Holder {
                holder_name: text("holder_name").unwrap_or_default(),
                device_name: text("device_name").unwrap_or_default(),
                since: text("since"),
                uncertain: code == "LEASE_UNCERTAIN",
            })
        }
        (_, "LEASE_NOT_HELD") => ApiError::LeaseLost,
        (_, "FENCING_TOKEN_STALE") => ApiError::Fenced {
            state: body
                .pointer("/safe_details/state")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 32)
                .unwrap_or("superseded")
                .to_owned(),
        },
        (status, "") => ApiError::Code {
            status,
            code: format!("HTTP_{status}"),
        },
        (status, c) => ApiError::Code {
            status,
            code: c.to_owned(),
        },
    }
}

/// A fixed bearer token over [`Http`] (end-to-end tests, command-line tools). The desktop uses its session instead.
pub struct BearerTransport {
    pub http: Http,
    pub base: String,
    pub token: String,
}

impl Transport for BearerTransport {
    fn call(
        &self,
        method: Method,
        path: &str,
        idempotency_key: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Value, ApiError> {
        let url = Url::parse(&format!("{}{path}", self.base)).map_err(|_| bad())?;
        let headers: Vec<(&str, &str)> = idempotency_key
            .map(|k| vec![("idempotency-key", k)])
            .unwrap_or_default();
        let res = self
            .http
            .request(method, &url, Some(&self.token), &headers, body)
            .map_err(|e| match e {
                HttpError::Offline => ApiError::Offline,
                _ => bad(),
            })?;
        let json = res.json().ok_or_else(bad)?;
        if res.ok() {
            Ok(json)
        } else {
            Err(map_error(res.status, &json))
        }
    }
}

pub fn id_ok(prefix: &str, s: &str) -> bool {
    s.len() == prefix.len() + 27
        && s.starts_with(prefix)
        && s.as_bytes()[prefix.len()] == b'_'
        && s.as_bytes()[prefix.len() + 1..]
            .iter()
            .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(b))
}

fn bad() -> ApiError {
    ApiError::Code {
        status: 502,
        code: "CLOUD_BAD_RESPONSE".into(),
    }
}

fn s(v: &Value, ptr: &str) -> Result<String, ApiError> {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(bad)
}

fn n(v: &Value, ptr: &str) -> Result<u64, ApiError> {
    v.pointer(ptr)
        .and_then(Value::as_f64)
        .filter(|f| *f >= 0.0)
        .map(|f| f as u64)
        .ok_or_else(bad)
}

pub fn snapshot_info(v: &Value) -> Result<SnapshotInfo, ApiError> {
    Ok(SnapshotInfo {
        id: s(v, "/id")?,
        version: v.get("version").and_then(Value::as_i64).ok_or_else(bad)?,
        digest: s(v, "/digest")?,
        ciphertext_size: n(v, "/ciphertext_size")?,
        plaintext_size: n(v, "/plaintext_size")?,
        platform: s(v, "/platform")?,
        browser_version: s(v, "/browser_version")?,
        schema_version: u32::try_from(n(v, "/schema_version")?).map_err(|_| bad())?,
        device_id: v
            .get("device_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        committed_at: v
            .get("committed_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn data_key(v: &Value) -> Result<SealKey, ApiError> {
    SealKey::from_base64(
        v.pointer("/key/data_key")
            .and_then(Value::as_str)
            .ok_or_else(bad)?,
    )
    .map_err(|_| bad())
}

/// The snapshot API over any [`Transport`]: the desktop's signed-in session, or a bearer token (tests and tools).
/// Object transfers use [`pb_cloud::Transfer`] (it implements [`crate::Objects`]).
pub struct RestApi<T> {
    pub transport: T,
    /// This device's enrolled id (leases are taken for it).
    pub device: String,
}

impl<T: Transport> RestApi<T> {
    fn path(&self, org: &str, profile: &str, tail: &str) -> Result<String, ApiError> {
        if !id_ok("org", org) || !id_ok("prf", profile) {
            return Err(bad());
        }
        Ok(format!("/v1/orgs/{org}/profiles/{profile}{tail}"))
    }
    fn snap_path(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        tail: &str,
    ) -> Result<String, ApiError> {
        if !id_ok("snp", snapshot) {
            return Err(bad());
        }
        self.path(org, profile, &format!("/snapshots/{snapshot}{tail}"))
    }
}

impl<T: Transport> SyncApi for RestApi<T> {
    fn acquire_lease(&self, org: &str, profile: &str, key: &str) -> Result<String, ApiError> {
        let v = self.transport.call(
            Method::Post,
            &self.path(org, profile, "/lease")?,
            Some(key),
            Some(&json!({ "device_id": self.device, "ttl_seconds": LEASE_SECONDS })),
        )?;
        s(&v, "/fencing_token")
    }
    fn renew_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError> {
        self.transport
            .call(
                Method::Post,
                &self.path(org, profile, "/lease/renew")?,
                None,
                Some(&json!({ "fencing_token": fencing, "ttl_seconds": LEASE_SECONDS })),
            )
            .map(|_| ())
    }
    fn release_lease(&self, org: &str, profile: &str, fencing: &str) -> Result<(), ApiError> {
        self.transport
            .call(
                Method::Post,
                &self.path(org, profile, "/lease/release")?,
                None,
                Some(&json!({ "fencing_token": fencing })),
            )
            .map(|_| ())
    }
    fn init(
        &self,
        org: &str,
        profile: &str,
        key: &str,
        req: &InitRequest,
    ) -> Result<InitResult, ApiError> {
        let body = serde_json::to_value(req).map_err(|_| bad())?;
        let v = self.transport.call(
            Method::Post,
            &self.path(org, profile, "/snapshots/init")?,
            Some(key),
            Some(&body),
        )?;
        Ok(InitResult {
            operation_id: s(&v, "/operation/id")?,
            snapshot_id: s(&v, "/key/snapshot_id")?,
            org_id: s(&v, "/key/org_id")?,
            profile_id: s(&v, "/key/profile_id")?,
            key_version: s(&v, "/key/key_version")?,
            schema_version: u32::try_from(n(&v, "/key/schema_version")?).map_err(|_| bad())?,
            data_key: data_key(&v)?,
            part_size: n(&v, "/upload/part_size")?,
            max_parts: u32::try_from(n(&v, "/upload/max_parts")?).map_err(|_| bad())?,
            max_bytes: n(&v, "/upload/max_bytes")?,
        })
    }
    fn part_urls(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        parts: &[u32],
    ) -> Result<Vec<PartUrl>, ApiError> {
        let v = self.transport.call(
            Method::Post,
            &self.snap_path(org, profile, snapshot, "/parts")?,
            None,
            Some(&json!({ "part_numbers": parts })),
        )?;
        serde_json::from_value(v.get("parts").cloned().ok_or_else(bad)?).map_err(|_| bad())
    }
    fn stored_parts(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
    ) -> Result<Vec<StoredPart>, ApiError> {
        let v = self.transport.call(
            Method::Get,
            &self.snap_path(org, profile, snapshot, "/parts")?,
            None,
            None,
        )?;
        serde_json::from_value(v.get("parts").cloned().ok_or_else(bad)?).map_err(|_| bad())
    }
    fn commit(
        &self,
        org: &str,
        profile: &str,
        snapshot: &str,
        req: &CommitRequest,
    ) -> Result<Operation, ApiError> {
        let body = serde_json::to_value(req).map_err(|_| bad())?;
        let v = self.transport.call(
            Method::Post,
            &self.snap_path(org, profile, snapshot, "/commit")?,
            None,
            Some(&body),
        )?;
        serde_json::from_value(v).map_err(|_| bad())
    }
    fn cancel(&self, org: &str, profile: &str, snapshot: &str) -> Result<(), ApiError> {
        self.transport
            .call(
                Method::Post,
                &self.snap_path(org, profile, snapshot, "/cancel")?,
                None,
                None,
            )
            .map(|_| ())
    }
    fn operation(&self, org: &str, operation: &str) -> Result<Operation, ApiError> {
        if !id_ok("org", org) || !id_ok("syn", operation) {
            return Err(bad());
        }
        let v = self.transport.call(
            Method::Get,
            &format!("/v1/orgs/{org}/sync-operations/{operation}"),
            None,
            None,
        )?;
        serde_json::from_value(v).map_err(|_| bad())
    }
    fn restore_plan(
        &self,
        org: &str,
        profile: &str,
        snapshot: Option<&str>,
    ) -> Result<RestorePlan, ApiError> {
        let body = match snapshot {
            Some(id) if id_ok("snp", id) => json!({ "snapshot_id": id }),
            Some(_) => return Err(bad()),
            None => json!({}),
        };
        let v = self.transport.call(
            Method::Post,
            &self.path(org, profile, "/restore-plans")?,
            None,
            Some(&body),
        )?;
        Ok(RestorePlan {
            snapshot: snapshot_info(v.get("snapshot").ok_or_else(bad)?)?,
            head_version: v
                .get("head_version")
                .and_then(Value::as_i64)
                .ok_or_else(bad)?,
            download_url: s(&v, "/download/url")?,
            org_id: s(&v, "/key/org_id")?,
            profile_id: s(&v, "/key/profile_id")?,
            key_version: s(&v, "/key/key_version")?,
            data_key: data_key(&v)?,
        })
    }
    fn latest(&self, org: &str, profile: &str) -> Result<Option<SnapshotInfo>, ApiError> {
        self.latest_inner(org, profile)
    }
}

impl<T: Transport> RestApi<T> {
    fn lease_path(
        &self,
        org: &str,
        profile: &str,
        lease: &str,
        tail: &str,
    ) -> Result<String, ApiError> {
        if !id_ok("lse", lease) {
            return Err(bad());
        }
        self.path(org, profile, &format!("/leases/{lease}{tail}"))
    }
}

impl<T: Transport> SessionApi for RestApi<T> {
    fn open_session(
        &self,
        org: &str,
        profile: &str,
        key: &str,
        req: &OpenRequest,
    ) -> Result<SessionOpened, ApiError> {
        let body = serde_json::to_value(req).map_err(|_| bad())?;
        let v = self.transport.call(
            Method::Post,
            &self.path(org, profile, "/leases")?,
            Some(key),
            Some(&body),
        )?;
        serde_json::from_value(v).map_err(|_| bad())
    }
    fn heartbeat(
        &self,
        org: &str,
        profile: &str,
        lease: &str,
        fencing: &str,
        run_state: Option<&str>,
    ) -> Result<Beat, ApiError> {
        let mut body = json!({ "fencing_token": fencing });
        if let Some(r) = run_state {
            body["run_state"] = json!(r);
        }
        let v = self.transport.call(
            Method::Post,
            &self.lease_path(org, profile, lease, "/heartbeat")?,
            None,
            Some(&body),
        )?;
        serde_json::from_value(v).map_err(|_| bad())
    }
    fn release_session(
        &self,
        org: &str,
        profile: &str,
        lease: &str,
        fencing: &str,
        outcome: SessionOutcome,
        handoff_note: Option<&str>,
    ) -> Result<(), ApiError> {
        let mut body = json!({ "fencing_token": fencing, "outcome": outcome.as_str() });
        if let Some(n) = handoff_note.filter(|n| !n.trim().is_empty()) {
            body["handoff_note"] = json!(n);
        }
        self.transport
            .call(
                Method::Post,
                &self.lease_path(org, profile, lease, "/release")?,
                None,
                Some(&body),
            )
            .map(|_| ())
    }
    fn current_lease(&self, org: &str, profile: &str) -> Result<Option<LeaseInfo>, ApiError> {
        let v = self.transport.call(
            Method::Get,
            &self.path(org, profile, "/leases/current")?,
            None,
            None,
        )?;
        match v.get("lease") {
            Some(Value::Null) | None => Ok(None),
            Some(l) => serde_json::from_value(l.clone())
                .map(Some)
                .map_err(|_| bad()),
        }
    }
}

impl<T: Transport> RestApi<T> {
    fn latest_inner(&self, org: &str, profile: &str) -> Result<Option<SnapshotInfo>, ApiError> {
        let v = self.transport.call(
            Method::Get,
            &self.path(org, profile, "/snapshots?limit=1")?,
            None,
            None,
        )?;
        match v.pointer("/items/0") {
            Some(item) => Ok(Some(snapshot_info(item)?)),
            None => Ok(None),
        }
    }
}
