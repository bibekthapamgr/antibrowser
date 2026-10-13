//! Steps and the broker against the in-memory browser (real Chromium: tests/chromium.rs).

use crate::broker::{Broker, BrokerConfig, Refusal};
use crate::fake::{FakeBrowser, FakePage};
use crate::{Condition, Hub, Page, StepError, close_browser};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, connect};

const SITES: &[&str] = &["https://app.example.com", "http://localhost:3000"];

fn sites() -> Vec<String> {
    SITES.iter().map(|s| (*s).to_owned()).collect()
}

fn start(page: FakePage) -> (FakeBrowser, Hub) {
    let (fake, ends) = FakeBrowser::start(page).unwrap_or_else(|e| panic!("fake: {e}"));
    (fake, Hub::from(ends))
}

#[test]
fn opens_an_approved_address_and_reports_origin_status_and_time_only() {
    let (fake, hub) = start(FakePage {
        status: 201,
        ..FakePage::default()
    });
    let page = Page::attach(hub, sites()).unwrap_or_else(|e| panic!("{e}"));
    let opened = page
        .open_url("https://app.example.com/login?next=%2Fhome", Duration::from_secs(5))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(opened.final_origin, "https://app.example.com");
    assert_eq!(opened.http_status, Some(201));
    assert!(fake.methods().contains(&"Page.navigate".to_owned()));
    // Never a debugging port, a script, an input event or a form.
    for m in fake.methods() {
        assert!(
            !m.starts_with("Input.") && m != "Runtime.compileScript" && m != "DOM.setAttributeValue",
            "{m}"
        );
    }
}

#[test]
fn refuses_unapproved_addresses_and_pages_that_leave_the_approved_sites() {
    let (fake, hub) = start(FakePage::default());
    let page = Page::attach(hub, sites()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        page.open_url("https://evil.example.net/", Duration::from_secs(2)),
        Err(StepError::UrlNotApproved)
    );
    assert!(!fake.methods().contains(&"Page.navigate".to_owned()));
    fake.set_page(|p| p.redirect_to = Some("https://login.other.example/sso".into()));
    assert_eq!(
        page.open_url("https://app.example.com/", Duration::from_secs(2)),
        Err(StepError::PageLeftApprovedSites)
    );
    // No screenshot or condition on a page outside the approved sites.
    assert_eq!(page.screenshot(1 << 20), Err(StepError::PageLeftApprovedSites));
    assert_eq!(
        page.wait_for(&Condition::Text("x".into()), Duration::from_millis(300)),
        Err(StepError::PageLeftApprovedSites)
    );
}

#[test]
fn waits_for_conditions_with_the_job_text_as_data_never_code() {
    let (fake, hub) = start(FakePage::default());
    let page = Page::attach(hub, sites()).unwrap_or_else(|e| panic!("{e}"));
    page.open_url("http://localhost:3000/app", Duration::from_secs(2))
        .unwrap_or_else(|e| panic!("{e}"));
    fake.set_page(|p| {
        p.selectors = vec!["#ready".into()];
        p.title = "Dashboard - Acme".into();
        p.text = "Welcome back".into();
    });
    assert!(page.wait_for(&Condition::Selector("#ready".into()), Duration::from_secs(2)).is_ok());
    assert!(page.wait_for(&Condition::TitleContains("Dashboard".into()), Duration::from_secs(2)).is_ok());
    assert!(page.wait_for(&Condition::Text("Welcome".into()), Duration::from_secs(2)).is_ok());
    assert!(
        page.wait_for(&Condition::UrlPrefix("http://localhost:3000/app".into()), Duration::from_secs(1))
            .is_ok()
    );
    assert_eq!(
        page.wait_for(&Condition::Selector("#never".into()), Duration::from_millis(400)),
        Err(StepError::ConditionNotMet)
    );
    // A hostile selector stays a string literal argument of a fixed function.
    let evil = "\")+alert(1)+(\"";
    let _ = page.wait_for(&Condition::Selector(evil.into()), Duration::from_millis(100));
    let exprs = fake.state.lock().map(|s| s.expressions.clone()).unwrap_or_default();
    let last = exprs.last().cloned().unwrap_or_default();
    assert!(last.starts_with("(function(s){try{return document.querySelector(s)!==null}"));
    assert!(last.ends_with(&format!("({})", serde_json::to_string(evil).unwrap_or_default())));
    let methods = fake.methods();
    assert!(methods.contains(&"Page.createIsolatedWorld".to_owned()));
}

#[test]
fn screenshots_are_jpeg_and_bounded() {
    let (fake, hub) = start(FakePage::default());
    let page = Page::attach(hub, sites()).unwrap_or_else(|e| panic!("{e}"));
    page.open_url("https://app.example.com/", Duration::from_secs(2))
        .unwrap_or_else(|e| panic!("{e}"));
    let shot = page.screenshot(1 << 20).unwrap_or_else(|e| panic!("{e}"));
    assert!(shot.jpeg.starts_with(&[0xff, 0xd8, 0xff]));
    assert_eq!((shot.width, shot.height), (1280, 720));
    fake.set_page(|p| p.screenshot_bytes = 4096);
    assert_eq!(page.screenshot(1000), Err(StepError::ArtifactTooLarge));
}

#[test]
fn navigation_timeouts_errors_and_a_closed_browser_are_reported() {
    let (fake, hub) = start(FakePage {
        hang: true,
        ..FakePage::default()
    });
    let page = Page::attach(hub.clone(), sites()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        page.open_url("https://app.example.com/", Duration::from_millis(300)),
        Err(StepError::Timeout)
    );
    fake.set_page(|p| {
        p.hang = false;
        p.nav_error = Some("net::ERR_NAME_NOT_RESOLVED".into());
    });
    assert_eq!(
        page.open_url("https://app.example.com/", Duration::from_secs(2)),
        Err(StepError::NavigationFailed)
    );
    assert!(close_browser(&hub).is_ok());
    std::thread::sleep(Duration::from_millis(100));
    assert!(fake.closed());
    assert!(hub.is_closed());
    assert_eq!(page.screenshot(1 << 20), Err(StepError::BrowserClosed));
}

// ------------------------------------------------------------------------------------------------- broker
fn broker(hub: Hub, secret: &str, within: Duration) -> Broker {
    let digest: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
    Broker::start(
        hub,
        BrokerConfig {
            job_id: "job_01JA0000000000000000000000".into(),
            capability_sha256: digest,
            connect_within: within,
        },
    )
    .unwrap_or_else(|e| panic!("broker: {e}"))
}

fn request(endpoint: &str, headers: &[(&str, &str)]) -> tungstenite::handshake::client::Request {
    let mut req = endpoint
        .into_client_request()
        .unwrap_or_else(|e| panic!("request: {e}"));
    for (k, v) in headers {
        req.headers_mut().insert(
            tungstenite::http::HeaderName::from_bytes(k.as_bytes()).unwrap_or_else(|e| panic!("{e}")),
            tungstenite::http::HeaderValue::from_str(v).unwrap_or_else(|e| panic!("{e}")),
        );
    }
    req
}

fn status_of(r: Result<(tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, tungstenite::handshake::client::Response), tungstenite::Error>) -> u16 {
    match r {
        Ok(_) => 101,
        Err(tungstenite::Error::Http(resp)) => resp.status().as_u16(),
        Err(e) => panic!("unexpected: {e}"),
    }
}

#[test]
fn the_broker_relays_only_an_authenticated_local_script() {
    let secret = "capability-".to_owned() + &hex::encode(rand_bytes());
    let (_fake, hub) = start(FakePage::default());
    let b = broker(hub.clone(), &secret, Duration::from_secs(30));
    let endpoint = b.endpoint();
    assert!(endpoint.starts_with("ws://127.0.0.1:"));
    let bearer = format!("Bearer {secret}");
    // No capability, a wrong one, a web page (Origin), a rebinding Host, a wrong path.
    assert_eq!(status_of(connect(request(&endpoint, &[]))), 401);
    assert_eq!(status_of(connect(request(&endpoint, &[("authorization", "Bearer nope")]))), 401);
    assert_eq!(
        status_of(connect(request(
            &endpoint,
            &[("authorization", bearer.as_str()), ("origin", "https://evil.example")]
        ))),
        403
    );
    let rebind = endpoint.replace("127.0.0.1", "attacker.example");
    let mut r = request(&endpoint, &[("authorization", bearer.as_str())]);
    r.headers_mut().insert(
        "host",
        tungstenite::http::HeaderValue::from_str(
            rebind.trim_start_matches("ws://").split('/').next().unwrap_or(""),
        )
        .unwrap_or_else(|e| panic!("{e}")),
    );
    assert_eq!(status_of(connect(r)), 403);
    let wrong = endpoint.replace("/cdp/job_", "/cdp/xob_");
    assert_eq!(status_of(connect(request(&wrong, &[("authorization", bearer.as_str())]))), 404);
    let refusals = b.refusals.lock().map(|r| r.clone()).unwrap_or_default();
    assert_eq!(
        refusals,
        vec![Refusal::Capability, Refusal::Capability, Refusal::Origin, Refusal::Host, Refusal::Path]
    );

    // The real script: commands reach the browser, answers come back.
    let (mut ws, _) = connect(request(&endpoint, &[("authorization", bearer.as_str())]))
        .unwrap_or_else(|e| panic!("connect: {e}"));
    ws.send(Message::text(json!({ "id": 1, "method": "Browser.getVersion" }).to_string()))
        .unwrap_or_else(|e| panic!("{e}"));
    let answer: Value = loop {
        if let Message::Text(t) = ws.read().unwrap_or_else(|e| panic!("{e}")) {
            break serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
        }
    };
    assert_eq!(answer.pointer("/result/product").and_then(Value::as_str), Some("Fake/1.0"));
    // A second client while the first is connected is refused (one at a time).
    let second = connect(request(&endpoint, &[("authorization", bearer.as_str())]));
    if let Ok((mut ws2, _)) = second {
        let closed = matches!(ws2.read(), Ok(Message::Close(_)) | Err(_));
        assert!(closed);
    }
    // Ids in the app's own range are never accepted from a client.
    ws.send(Message::text(json!({ "id": crate::hub::OWN_IDS + 1, "method": "Browser.close" }).to_string()))
        .unwrap_or_else(|e| panic!("{e}"));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!_fake.closed());
    assert!(hub.relayed() >= 1);
    b.stop();
}

#[test]
fn the_capability_expires_if_nobody_connects_in_time() {
    let secret = "late-".to_owned() + &hex::encode(rand_bytes());
    let (_fake, hub) = start(FakePage::default());
    let b = broker(hub, &secret, Duration::from_millis(1));
    std::thread::sleep(Duration::from_millis(20));
    let bearer = format!("Bearer {secret}");
    assert_eq!(status_of(connect(request(&b.endpoint(), &[("authorization", bearer.as_str())]))), 401);
    assert_eq!(b.refusals.lock().map(|r| r.clone()).unwrap_or_default(), vec![Refusal::Expired]);
}

fn rand_bytes() -> [u8; 16] {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b
}
