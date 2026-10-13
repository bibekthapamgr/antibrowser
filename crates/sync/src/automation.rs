//! What a computer that runs automation jobs needs from the control plane (milestone 10, ADR-0017): enrollment,
//! polling (heartbeat, new jobs, cancellations), reports and screenshot uploads. The server is the source of truth
//! for every job's state; a computer that restarts receives the jobs it holds again, with where to continue.

use crate::api::ApiError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub org_id: String,
    pub device_id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub accepts: String,
    pub debug_allowed: bool,
    pub max_jobs: u32,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub running_jobs: u32,
    #[serde(default)]
    pub version: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnrollRequest {
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub accepts: String,
    pub max_jobs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningJob {
    pub job_id: String,
    pub attempt: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PollRequest {
    pub running: Vec<RunningJob>,
    pub capacity: u32,
    pub debug_allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobInfo {
    pub id: String,
    pub org_id: String,
    pub profile_id: String,
    #[serde(default)]
    pub profile_name: String,
    #[serde(default)]
    pub client_name: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    pub state: String,
    pub attempt: u32,
    #[serde(default)]
    pub keep_open_minutes: Option<u32>,
    #[serde(default)]
    pub debug: bool,
    #[serde(default)]
    pub requested_by_name: String,
    #[serde(default)]
    pub cancel_requested_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobStepInfo {
    pub seq: u32,
    pub action: String,
    #[serde(default)]
    pub effect: String,
    #[serde(default)]
    pub input: Value,
    pub state: String,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaimedJob {
    pub job: JobInfo,
    pub steps: Vec<JobStepInfo>,
    pub allowed_origins: Vec<String>,
    pub lease_key: String,
    #[serde(default)]
    pub debug_capability_sha256: Option<String>,
    #[serde(default)]
    pub resume_from: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PollAnswer {
    pub agent: AgentInfo,
    pub assigned: Vec<ClaimedJob>,
    pub cancel: Vec<String>,
    pub abandon: Vec<String>,
    pub poll_after_seconds: u64,
}

/// What the computer reports, in order (the API's `JobReport`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JobReport {
    Started {
        attempt: u32,
        lease_id: String,
        fencing_token: String,
    },
    StepStarted {
        attempt: u32,
        seq: u32,
    },
    StepFinished {
        attempt: u32,
        seq: u32,
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<Value>,
    },
    Released {
        attempt: u32,
        error_code: String,
    },
    Finished {
        attempt: u32,
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportAnswer {
    pub state: String,
    pub cancel_requested: bool,
}

pub trait AutomationApi: Send + Sync {
    fn enroll_agent(&self, org: &str, req: &EnrollRequest) -> Result<AgentInfo, ApiError>;
    fn remove_agent(&self, org: &str, agent: &str) -> Result<(), ApiError>;
    fn poll_agent(&self, org: &str, agent: &str, req: &PollRequest)
    -> Result<PollAnswer, ApiError>;
    fn report_job(
        &self,
        org: &str,
        job: &str,
        report: &JobReport,
    ) -> Result<ReportAnswer, ApiError>;
    /// Uploads a screenshot for a running screenshot step; returns its id.
    #[allow(clippy::too_many_arguments)]
    fn upload_artifact(
        &self,
        org: &str,
        job: &str,
        seq: u32,
        attempt: u32,
        width: u32,
        height: u32,
        jpeg: &[u8],
    ) -> Result<String, ApiError>;
}
