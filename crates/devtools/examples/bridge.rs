//! For the Playwright compatibility test (packages/sdk/test/playwright.test.ts): starts a browser with the protected
//! pipe and the loopback broker exactly as a debugging job does, prints `{"endpoint": "…"}` on one line, and keeps
//! running until its standard input closes. Environment: PB_CHROME_PATH (browser), PB_CAPABILITY_SHA256 (hex digest of
//! the capability secret the test generated), PB_CHROME_NO_SANDBOX=1 only in root containers.

use pb_devtools::broker::{Broker, BrokerConfig};
use pb_devtools::{DevtoolsPipes, Hub, close_browser};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let exe = std::env::var("PB_CHROME_PATH")?;
    let digest = hex::decode(std::env::var("PB_CAPABILITY_SHA256")?)?;
    let capability: [u8; 32] = digest.try_into().map_err(|_| "PB_CAPABILITY_SHA256 must be 32 bytes")?;
    let dir = tempfile::tempdir()?;
    let pipes = DevtoolsPipes::create()?;
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--user-data-dir={}", dir.path().display()))
        .args(["--no-first-run", "--no-default-browser-check", "--enable-automation", "--headless=new"])
        .args(["--disable-gpu", "--use-mock-keychain", "--password-store=basic"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if std::env::var("PB_CHROME_NO_SANDBOX").as_deref() == Ok("1") {
        cmd.arg("--no-sandbox");
    }
    pipes.attach(&mut cmd);
    cmd.arg("about:blank");
    let mut child = cmd.spawn()?;
    let hub = Hub::from(pipes.into_ends());
    hub.call("Browser.getVersion", serde_json::json!({}), None, Duration::from_secs(30))?;
    let broker = Broker::start(
        hub.clone(),
        BrokerConfig {
            job_id: "job_01JA0000000000000000000000".into(),
            capability_sha256: capability,
            connect_within: Duration::from_secs(120),
        },
    )?;
    println!("{}", serde_json::json!({ "endpoint": broker.endpoint() }));
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    broker.stop();
    let _ = close_browser(&hub);
    let _ = child.wait();
    Ok(())
}
