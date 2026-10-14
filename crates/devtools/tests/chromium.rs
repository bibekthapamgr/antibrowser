//! The protected pipe, the workflow steps and the broker against a real Chromium (milestone 10). Runs when
//! PB_CHROME_PATH names a Chromium or headless-shell executable (CI installs the stable headless shell on Windows,
//! macOS and Linux); otherwise each test says it was skipped. PB_CHROME_NO_SANDBOX=1 only where the sandbox cannot
//! run (a root container, or a Linux runner that blocks unprivileged user namespaces); the app never disables it.

use pb_devtools::broker::{Broker, BrokerConfig};
use pb_devtools::{Condition, DevtoolsPipes, Hub, Page, StepError, close_browser};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn chrome() -> Option<String> {
    let p = std::env::var("PB_CHROME_PATH").ok()?;
    if std::path::Path::new(&p).is_file() {
        Some(p)
    } else {
        eprintln!("PB_CHROME_PATH does not exist: {p}");
        None
    }
}

/// A tiny site: `/` shows a title and, after 300 ms, `#ready`; `/away` redirects to another origin.
fn site() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let mut s = &stream;
                let response = if path.starts_with("/away") {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                } else {
                    let body = "<!doctype html><title>Acme Test Portal</title><body><p>Welcome back</p>\
                        <script>setTimeout(function(){var d=document.createElement('div');d.id='ready';\
                        d.textContent='Ready';document.body.appendChild(d)},300)</script></body>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = s.write_all(response.as_bytes());
            });
        }
    });
    port
}

struct Browser {
    child: Child,
    hub: Hub,
    _dir: tempfile::TempDir,
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn launch(exe: &str) -> Browser {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
    let pipes = DevtoolsPipes::create().unwrap_or_else(|e| panic!("pipes: {e}"));
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--user-data-dir={}", dir.path().display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--enable-automation",
            "--headless=new",
        ])
        .args([
            "--disable-gpu",
            "--use-mock-keychain",
            "--password-store=basic",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if std::env::var("PB_CHROME_NO_SANDBOX").as_deref() == Ok("1") {
        cmd.arg("--no-sandbox");
    }
    pipes.attach(&mut cmd);
    cmd.arg("about:blank");
    let child = cmd.spawn().unwrap_or_else(|e| panic!("spawn: {e}"));
    let hub = Hub::from(pipes.into_ends());
    Browser {
        child,
        hub,
        _dir: dir,
    }
}

#[test]
fn steps_run_over_the_protected_pipe_on_a_real_browser() {
    let Some(exe) = chrome() else {
        eprintln!("skipped: PB_CHROME_PATH is not set");
        return;
    };
    let port = site();
    let approved = vec![format!("http://127.0.0.1:{port}")];
    let mut b = launch(&exe);
    // The pipe answers (no port was opened: nothing listens for DevTools).
    let version = b
        .hub
        .call(
            "Browser.getVersion",
            json!({}),
            None,
            Duration::from_secs(30),
        )
        .unwrap_or_else(|e| panic!("the browser did not answer over the pipe: {e}"));
    assert!(
        version
            .get("product")
            .and_then(Value::as_str)
            .is_some_and(|p| p.contains("Chrome"))
    );
    let page = Page::attach(b.hub.clone(), approved).unwrap_or_else(|e| panic!("attach: {e}"));
    let opened = page
        .open_url(
            &format!("http://127.0.0.1:{port}/start"),
            Duration::from_secs(30),
        )
        .unwrap_or_else(|e| panic!("open: {e}"));
    assert_eq!(opened.final_origin, format!("http://127.0.0.1:{port}"));
    assert_eq!(opened.http_status, Some(200));
    page.wait_for(
        &Condition::Selector("#ready".into()),
        Duration::from_secs(10),
    )
    .unwrap_or_else(|e| panic!("selector: {e}"));
    page.wait_for(
        &Condition::TitleContains("Test Portal".into()),
        Duration::from_secs(5),
    )
    .unwrap_or_else(|e| panic!("title: {e}"));
    page.wait_for(
        &Condition::Text("Welcome back".into()),
        Duration::from_secs(5),
    )
    .unwrap_or_else(|e| panic!("text: {e}"));
    assert_eq!(
        page.wait_for(
            &Condition::Selector("#missing".into()),
            Duration::from_millis(600)
        ),
        Err(StepError::ConditionNotMet)
    );
    let shot = page
        .screenshot(1_572_864)
        .unwrap_or_else(|e| panic!("screenshot: {e}"));
    assert!(shot.jpeg.starts_with(&[0xff, 0xd8, 0xff]));
    assert!(shot.width > 0 && shot.height > 0);
    // A redirect to another origin is refused after the fact.
    assert_eq!(
        page.open_url(
            &format!("http://127.0.0.1:{port}/away"),
            Duration::from_secs(30)
        ),
        Err(StepError::PageLeftApprovedSites)
    );
    close_browser(&b.hub).unwrap_or_else(|e| panic!("close: {e}"));
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if b.child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("the browser did not exit after Browser.close");
}

#[test]
fn automation_sessions_identify_as_automated() {
    let Some(exe) = chrome() else {
        eprintln!("skipped: PB_CHROME_PATH is not set");
        return;
    };
    let b = launch(&exe);
    let targets = b
        .hub
        .call(
            "Target.getTargets",
            json!({}),
            None,
            Duration::from_secs(30),
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let target = targets
        .pointer("/targetInfos")
        .and_then(Value::as_array)
        .and_then(|t| {
            t.iter()
                .find(|i| i.get("type").and_then(Value::as_str) == Some("page"))
        })
        .and_then(|i| i.get("targetId").and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_default();
    let session = b
        .hub
        .call(
            "Target.attachToTarget",
            json!({ "targetId": target, "flatten": true }),
            None,
            Duration::from_secs(10),
        )
        .ok()
        .and_then(|r| {
            r.get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let r = b
        .hub
        .call(
            "Runtime.evaluate",
            json!({ "expression": "navigator.webdriver === true", "returnByValue": true }),
            Some(&session),
            Duration::from_secs(10),
        )
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        r.pointer("/result/value").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn the_broker_hands_a_real_session_to_an_authenticated_script() {
    let Some(exe) = chrome() else {
        eprintln!("skipped: PB_CHROME_PATH is not set");
        return;
    };
    let b = launch(&exe);
    b.hub
        .call(
            "Browser.getVersion",
            json!({}),
            None,
            Duration::from_secs(30),
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let secret = format!("cap-{}", std::process::id());
    let broker = Broker::start(
        b.hub.clone(),
        BrokerConfig {
            job_id: "job_01JA0000000000000000000000".into(),
            capability_sha256: Sha256::digest(secret.as_bytes()).into(),
            connect_within: Duration::from_secs(30),
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    use tungstenite::client::IntoClientRequest;
    let mut req = broker
        .endpoint()
        .into_client_request()
        .unwrap_or_else(|e| panic!("{e}"));
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {secret}")
            .parse()
            .unwrap_or_else(|e| panic!("{e}")),
    );
    let (mut ws, _) = tungstenite::connect(req).unwrap_or_else(|e| panic!("{e}"));
    ws.send(tungstenite::Message::text(
        json!({ "id": 7, "method": "Target.getTargets" }).to_string(),
    ))
    .unwrap_or_else(|e| panic!("{e}"));
    let answer: Value = loop {
        if let tungstenite::Message::Text(t) = ws.read().unwrap_or_else(|e| panic!("{e}")) {
            let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            if v.get("id").and_then(Value::as_u64) == Some(7) {
                break v;
            }
        }
    };
    assert!(
        answer
            .pointer("/result/targetInfos")
            .and_then(Value::as_array)
            .is_some()
    );
    broker.stop();
}
