//! The allowlisted workflow steps (milestone 10): open an approved address, wait for a condition on an approved page,
//! take a diagnostic screenshot. Nothing here clicks, types, submits or runs code from a job: conditions are fixed
//! expressions with the job's text passed as a JSON string literal (data, never code), evaluated in an isolated world
//! (the page's own scripts cannot change what they see). Page content never leaves this module except as a yes/no
//! answer, an HTTP status, the page's origin and a screenshot the job asked for.

use crate::hub::{CdpError, Hub};
use crate::origin::{address_origin, origin_allowed};
use base64::Engine;
use serde_json::{Value, json};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

const CALL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StepError {
    #[error("timed out")]
    Timeout,
    #[error("the page could not be opened")]
    NavigationFailed,
    #[error("the page left the approved sites")]
    PageLeftApprovedSites,
    #[error("the condition was not met in time")]
    ConditionNotMet,
    #[error("the browser closed")]
    BrowserClosed,
    #[error("the screenshot is too large")]
    ArtifactTooLarge,
    #[error("the address is not on the approved sites")]
    UrlNotApproved,
    #[error("the browser does not support this")]
    Unsupported,
}

impl StepError {
    /// The job error code (packages/contracts JOB_ERROR_CODES).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Timeout => "TIMEOUT",
            Self::NavigationFailed => "NAVIGATION_FAILED",
            Self::PageLeftApprovedSites => "PAGE_LEFT_APPROVED_SITES",
            Self::ConditionNotMet => "CONDITION_NOT_MET",
            Self::BrowserClosed => "BROWSER_CLOSED",
            Self::ArtifactTooLarge => "ARTIFACT_TOO_LARGE",
            Self::UrlNotApproved => "URL_NOT_APPROVED",
            Self::Unsupported => "UNSUPPORTED_BROWSER",
        }
    }
}

impl From<CdpError> for StepError {
    fn from(e: CdpError) -> Self {
        match e {
            CdpError::Closed => Self::BrowserClosed,
            CdpError::Timeout => Self::Timeout,
            CdpError::Protocol { .. } => Self::Unsupported,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Condition {
    Selector(String),
    Text(String),
    TitleContains(String),
    UrlPrefix(String),
}

impl Condition {
    /// From a job step's `condition` object.
    pub fn from_json(v: &Value) -> Option<Self> {
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        match v.get("type").and_then(Value::as_str)? {
            "selector" => text("selector").map(Self::Selector),
            "text" => text("text").map(Self::Text),
            "title_contains" => text("text").map(Self::TitleContains),
            "url_prefix" => text("prefix").map(Self::UrlPrefix),
            _ => None,
        }
    }

    /// A fixed expression; the job's text is a JSON string literal argument (never spliced in as code).
    fn expression(&self) -> Option<String> {
        let lit = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
        match self {
            Self::Selector(s) => Some(format!(
                "(function(s){{try{{return document.querySelector(s)!==null}}catch(e){{return false}}}})({})",
                lit(s)
            )),
            Self::Text(t) => Some(format!(
                "(function(t){{return !!(document.body&&document.body.innerText.indexOf(t)>=0)}})({})",
                lit(t)
            )),
            Self::TitleContains(t) => Some(format!(
                "(function(t){{return String(document.title).indexOf(t)>=0}})({})",
                lit(t)
            )),
            Self::UrlPrefix(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub final_origin: String,
    pub http_status: Option<u16>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The first tab of the profile's browser, attached for the job's steps.
pub struct Page {
    hub: Hub,
    target: String,
    session: String,
    allowed: Vec<String>,
}

impl Page {
    /// Attaches to the first page (opening a blank one when there is none).
    pub fn attach(hub: Hub, allowed: Vec<String>) -> Result<Self, StepError> {
        let targets = hub.call("Target.getTargets", json!({}), None, CALL)?;
        let page = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .and_then(|t| {
                t.iter()
                    .find(|i| i.get("type").and_then(Value::as_str) == Some("page"))
                    .and_then(|i| i.get("targetId").and_then(Value::as_str))
                    .map(str::to_owned)
            });
        let target = match page {
            Some(t) => t,
            None => hub
                .call("Target.createTarget", json!({ "url": "about:blank" }), None, CALL)?
                .get("targetId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(StepError::Unsupported)?,
        };
        let session = hub
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
                None,
                CALL,
            )?
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(StepError::Unsupported)?;
        hub.call("Page.enable", json!({}), Some(&session), CALL)?;
        hub.call("Network.enable", json!({}), Some(&session), CALL)?;
        Ok(Self {
            hub,
            target,
            session,
            allowed,
        })
    }

    /// The page's current address.
    pub fn current_url(&self) -> Result<String, StepError> {
        let info = self.hub.call(
            "Target.getTargetInfo",
            json!({ "targetId": self.target }),
            None,
            CALL,
        )?;
        Ok(info
            .pointer("/targetInfo/url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned())
    }

    fn on_approved_page(&self) -> Result<String, StepError> {
        let url = self.current_url()?;
        if origin_allowed(&url, &self.allowed) {
            Ok(url)
        } else {
            Err(StepError::PageLeftApprovedSites)
        }
    }

    /// Opens an approved address and waits for the page's load event.
    pub fn open_url(&self, url: &str, timeout: Duration) -> Result<Opened, StepError> {
        if !origin_allowed(url, &self.allowed) {
            return Err(StepError::UrlNotApproved);
        }
        let start = Instant::now();
        let events = self.hub.events();
        let r = self
            .hub
            .call("Page.navigate", json!({ "url": url }), Some(&self.session), timeout)?;
        if r.get("errorText")
            .and_then(Value::as_str)
            .is_some_and(|e| !e.is_empty())
        {
            return Err(StepError::NavigationFailed);
        }
        let loader = r.get("loaderId").and_then(Value::as_str).map(str::to_owned);
        let mut status = None;
        if loader.is_some() {
            let deadline = start + timeout;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(StepError::Timeout);
                }
                match events.recv_timeout(left) {
                    Ok(e) if e.session_id.as_deref() != Some(&self.session) => {}
                    Ok(e) if e.method == "Network.responseReceived" => {
                        if e.params.get("type").and_then(Value::as_str) == Some("Document")
                            && e.params.get("loaderId").and_then(Value::as_str) == loader.as_deref()
                        {
                            status = e
                                .params
                                .pointer("/response/status")
                                .and_then(Value::as_u64)
                                .and_then(|s| u16::try_from(s).ok());
                        }
                    }
                    Ok(e) if e.method == "Page.loadEventFired" => break,
                    Ok(_) => {}
                    Err(RecvTimeoutError::Timeout) => return Err(StepError::Timeout),
                    Err(RecvTimeoutError::Disconnected) => return Err(StepError::BrowserClosed),
                }
            }
        }
        let final_url = self.on_approved_page()?;
        Ok(Opened {
            final_origin: address_origin(&final_url)
                .map(|o| o.display())
                .unwrap_or_default(),
            http_status: status,
            elapsed_ms: elapsed(start),
        })
    }

    /// Waits until the condition holds on an approved page (checked about four times a second).
    pub fn wait_for(&self, condition: &Condition, timeout: Duration) -> Result<u64, StepError> {
        let start = Instant::now();
        loop {
            let url = self.on_approved_page()?;
            let met = match condition {
                Condition::UrlPrefix(p) => url.starts_with(p.as_str()),
                c => self.evaluate(c).unwrap_or(false),
            };
            if met {
                return Ok(elapsed(start));
            }
            if start.elapsed() >= timeout {
                return Err(StepError::ConditionNotMet);
            }
            std::thread::sleep(Duration::from_millis(250).min(timeout.saturating_sub(start.elapsed())));
            if self.hub.is_closed() {
                return Err(StepError::BrowserClosed);
            }
        }
    }

    /// Evaluates a condition in a fresh isolated world of the main frame; only a boolean comes back.
    fn evaluate(&self, condition: &Condition) -> Result<bool, StepError> {
        let Some(expression) = condition.expression() else {
            return Ok(false);
        };
        let tree = self
            .hub
            .call("Page.getFrameTree", json!({}), Some(&self.session), CALL)?;
        let frame = tree
            .pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .ok_or(StepError::Unsupported)?;
        let world = self.hub.call(
            "Page.createIsolatedWorld",
            json!({ "frameId": frame, "worldName": "pb-automation", "grantUniveralAccess": false }),
            Some(&self.session),
            CALL,
        )?;
        let context = world
            .get("executionContextId")
            .and_then(Value::as_i64)
            .ok_or(StepError::Unsupported)?;
        let r = self.hub.call(
            "Runtime.evaluate",
            json!({ "expression": expression, "contextId": context, "returnByValue": true }),
            Some(&self.session),
            CALL,
        )?;
        Ok(r.pointer("/result/value").and_then(Value::as_bool) == Some(true))
    }

    /// A JPEG of the visible part of an approved page, at most `max_bytes` (quality lowered twice before refusing).
    pub fn screenshot(&self, max_bytes: usize) -> Result<Shot, StepError> {
        self.on_approved_page()?;
        let metrics = self
            .hub
            .call("Page.getLayoutMetrics", json!({}), Some(&self.session), CALL)?;
        let dim = |k: &str| {
            metrics
                .pointer(&format!("/cssVisualViewport/{k}"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .round()
                .clamp(0.0, 100_000.0) as u32
        };
        for quality in [80, 60, 40] {
            let r = self.hub.call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": quality }),
                Some(&self.session),
                Duration::from_secs(20),
            )?;
            let data = r.get("data").and_then(Value::as_str).unwrap_or("");
            let jpeg = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| StepError::Unsupported)?;
            if jpeg.len() <= max_bytes && jpeg.starts_with(&[0xff, 0xd8, 0xff]) {
                return Ok(Shot {
                    jpeg,
                    width: dim("clientWidth"),
                    height: dim("clientHeight"),
                });
            }
        }
        Err(StepError::ArtifactTooLarge)
    }

    /// Lets go of the tab (before a debugging session takes over the connection).
    pub fn detach(&self) {
        let _ = self.hub.call(
            "Target.detachFromTarget",
            json!({ "sessionId": self.session }),
            None,
            CALL,
        );
    }
}

/// Asks the browser to close (like closing its last window: a clean exit).
pub fn close_browser(hub: &Hub) -> Result<(), StepError> {
    hub.call("Browser.close", json!({}), None, Duration::from_secs(10))
        .map(|_| ())
        .or_else(|e| if e == CdpError::Closed { Ok(()) } else { Err(e.into()) })
}

fn elapsed(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}
