//! An in-memory browser for tests: answers the DevTools commands this crate uses over a real pipe (std anonymous
//! pipes), with a page whose address, title, text, selectors and HTTP status a test controls.

use base64::Engine;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct FakePage {
    pub url: String,
    pub title: String,
    pub text: String,
    pub selectors: Vec<String>,
    pub status: u16,
    /// Navigating to anything ends up here instead (a redirect).
    pub redirect_to: Option<String>,
    /// Navigation never finishes loading.
    pub hang: bool,
    /// Answers to `Page.navigate` carry this error.
    pub nav_error: Option<String>,
    /// Size of the screenshot it returns.
    pub screenshot_bytes: usize,
}

impl Default for FakePage {
    fn default() -> Self {
        Self {
            url: "about:blank".into(),
            title: String::new(),
            text: String::new(),
            selectors: vec![],
            status: 200,
            redirect_to: None,
            hang: false,
            nav_error: None,
            screenshot_bytes: 2048,
        }
    }
}

#[derive(Default, Debug)]
pub struct FakeState {
    pub page: FakePage,
    /// Methods received, in order.
    pub methods: Vec<String>,
    /// Expressions evaluated.
    pub expressions: Vec<String>,
    pub closed: bool,
}

#[derive(Clone)]
pub struct FakeBrowser {
    pub state: Arc<Mutex<FakeState>>,
}

impl FakeBrowser {
    /// Starts the fake and returns it with the app's ends of its pipes.
    pub fn start(page: FakePage) -> std::io::Result<(Self, crate::PipeEnds)> {
        let (browser_reads, we_write) = std::io::pipe()?;
        let (we_read, browser_writes) = std::io::pipe()?;
        let state = Arc::new(Mutex::new(FakeState {
            page,
            ..FakeState::default()
        }));
        let s = state.clone();
        std::thread::spawn(move || serve(&s, browser_reads, browser_writes));
        Ok((
            Self { state },
            crate::PipeEnds {
                to_browser: pipe_file_w(we_write),
                from_browser: pipe_file_r(we_read),
            },
        ))
    }

    pub fn set_page(&self, f: impl FnOnce(&mut FakePage)) {
        if let Ok(mut s) = self.state.lock() {
            f(&mut s.page);
        }
    }

    pub fn methods(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|s| s.methods.clone())
            .unwrap_or_default()
    }

    pub fn closed(&self) -> bool {
        self.state.lock().map(|s| s.closed).unwrap_or(true)
    }
}

#[cfg(unix)]
fn pipe_file_w(w: std::io::PipeWriter) -> std::fs::File {
    std::fs::File::from(std::os::fd::OwnedFd::from(w))
}
#[cfg(unix)]
fn pipe_file_r(r: std::io::PipeReader) -> std::fs::File {
    std::fs::File::from(std::os::fd::OwnedFd::from(r))
}
#[cfg(windows)]
fn pipe_file_w(w: std::io::PipeWriter) -> std::fs::File {
    std::fs::File::from(std::os::windows::io::OwnedHandle::from(w))
}
#[cfg(windows)]
fn pipe_file_r(r: std::io::PipeReader) -> std::fs::File {
    std::fs::File::from(std::os::windows::io::OwnedHandle::from(r))
}

const SESSION: &str = "S1";
const TARGET: &str = "T1";

fn serve(state: &Mutex<FakeState>, reader: std::io::PipeReader, mut writer: std::io::PipeWriter) {
    let mut r = BufReader::new(reader);
    let mut buf = Vec::new();
    let mut loads = 0u32;
    loop {
        buf.clear();
        match r.read_until(0, &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        buf.pop();
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let method = v
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        let session = v.get("sessionId").cloned();
        let mut out: Vec<Value> = vec![];
        let mut close = false;
        {
            let Ok(mut s) = state.lock() else { return };
            s.methods.push(method.clone());
            let reply = |result: Value| {
                let mut m = json!({ "id": id, "result": result });
                if let (Some(sid), Some(o)) = (&session, m.as_object_mut()) {
                    o.insert("sessionId".into(), sid.clone());
                }
                m
            };
            match method.as_str() {
                "Target.getTargets" => out.push(reply(json!({
                    "targetInfos": [{ "targetId": TARGET, "type": "page", "url": s.page.url, "attached": false }]
                }))),
                "Target.attachToTarget" => out.push(reply(json!({ "sessionId": SESSION }))),
                "Target.detachFromTarget" | "Page.enable" | "Network.enable" | "Runtime.enable"
                | "Page.bringToFront" => {
                    out.push(reply(json!({})));
                }
                "Target.getTargetInfo" => out.push(reply(json!({
                    "targetInfo": { "targetId": TARGET, "type": "page", "url": s.page.url }
                }))),
                "Browser.getVersion" => out.push(reply(json!({
                    "protocolVersion": "1.3", "product": "Fake/1.0", "userAgent": "Fake", "jsVersion": "0"
                }))),
                "Page.navigate" => {
                    if let Some(err) = s.page.nav_error.clone() {
                        out.push(reply(json!({ "frameId": "F1", "errorText": err })));
                    } else {
                        loads += 1;
                        let loader = format!("L{loads}");
                        let url = params.get("url").and_then(Value::as_str).unwrap_or("").to_owned();
                        s.page.url = s.page.redirect_to.clone().unwrap_or(url);
                        out.push(reply(json!({ "frameId": "F1", "loaderId": loader })));
                        if !s.page.hang {
                            out.push(json!({
                                "method": "Network.responseReceived", "sessionId": SESSION,
                                "params": { "type": "Document", "loaderId": loader,
                                            "response": { "status": s.page.status, "url": s.page.url } }
                            }));
                            out.push(json!({ "method": "Page.loadEventFired", "sessionId": SESSION,
                                             "params": { "timestamp": 1.0 } }));
                        }
                    }
                }
                "Page.getFrameTree" => out.push(reply(json!({ "frameTree": { "frame": { "id": "F1" } } }))),
                "Page.createIsolatedWorld" => out.push(reply(json!({ "executionContextId": 7 }))),
                "Runtime.evaluate" => {
                    let expr = params.get("expression").and_then(Value::as_str).unwrap_or("").to_owned();
                    s.expressions.push(expr.clone());
                    let arg = expr
                        .rfind(")(")
                        .and_then(|i| serde_json::from_str::<String>(expr[i + 2..].trim_end_matches(')')).ok())
                        .unwrap_or_default();
                    let value = if expr.contains("querySelector") {
                        s.page.selectors.contains(&arg)
                    } else if expr.contains("innerText") {
                        s.page.text.contains(&arg)
                    } else if expr.contains("document.title") {
                        s.page.title.contains(&arg)
                    } else {
                        false
                    };
                    out.push(reply(json!({ "result": { "type": "boolean", "value": value } })));
                }
                "Page.getLayoutMetrics" => out.push(reply(json!({
                    "cssVisualViewport": { "clientWidth": 1280.0, "clientHeight": 720.0 }
                }))),
                "Page.captureScreenshot" => {
                    let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0];
                    jpeg.resize(s.page.screenshot_bytes.max(6), 0x11);
                    let n = jpeg.len();
                    jpeg[n - 2] = 0xff;
                    jpeg[n - 1] = 0xd9;
                    out.push(reply(json!({
                        "data": base64::engine::general_purpose::STANDARD.encode(&jpeg)
                    })));
                }
                "Browser.close" => {
                    s.closed = true;
                    out.push(reply(json!({})));
                    close = true;
                }
                _ => out.push(json!({ "id": id, "error": { "code": -32601, "message": "not found" } })),
            }
        }
        for m in out {
            let mut bytes = m.to_string().into_bytes();
            bytes.push(0);
            if writer.write_all(&bytes).is_err() {
                return;
            }
        }
        let _ = writer.flush();
        if close {
            return;
        }
    }
}
