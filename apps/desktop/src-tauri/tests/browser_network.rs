//! Milestone 05 leak tests against a REAL Chromium: proxy routing, DNS, WebRTC and environment settings.
//!
//! Runs only when `PB_TEST_BROWSER` points at a browser (see `tests/browser.rs` for the variables). Everything is
//! local and controlled: an in-process upstream proxy (HTTP or SOCKS5, with a login) that alone knows where the
//! test site `site.pb.test` is, a plain HTTP site, and a UDP "STUN server" that only counts packets.
//!
//! Evidence per test, gathered from the browser itself and from the servers:
//!  - Chromium's own network log (`--log-net-log`, test builds only): no local DNS lookup of the site's name, no
//!    UDP sockets (DNS or QUIC), and every TCP connection goes to the profile's loopback gateway;
//!  - the proxy's log (the browser's page, WebSocket and SOCKS requests arrived through it, with the login) and
//!    the site's log (language and Do Not Track headers; never a proxy login);
//!  - the STUN counter: zero packets from a fail-closed profile, while an unproxied control profile does send;
//!  - what the page saw: languages, time zone, reduced motion, window size, WebRTC candidates.
//!
//! Each test prints one `::notice` line with its findings, which CI turns into an annotation (leak-test evidence).

use pb_desktop_lib::events::RecordingSink;
use pb_desktop_lib::network::ProxyInput;
use pb_desktop_lib::operations::OpStatus;
use pb_desktop_lib::runtime::{HttpsFetcher, RuntimeConfig};
use pb_desktop_lib::secrets::MemoryStore;
use pb_desktop_lib::state::{AppState, ProfileChanges};
use pb_netproxy::testing::{ProxyOptions, TestProxy};
use pb_runtime::{
    BrowserInstall, PrivacyConfig, ProfileId, ProxyId, SystemInspector, SystemLauncher,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static SERIAL: Mutex<()> = Mutex::new(());

const SITE: &str = "site.pb.test";

const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>pb network</title><script>
(async () => {
  const q = new URLSearchParams(location.search);
  const out = { who: q.get('who') };
  try {
    out.languages = navigator.languages;
    out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.offset = new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset();
    out.reduced_motion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    out.permissions = {};
    for (const name of ['geolocation', 'camera', 'microphone']) {
      try { out.permissions[name] = (await navigator.permissions.query({ name })).state; }
      catch (e) { out.permissions[name] = 'unsupported'; }
    }
    // Through an HTTP proxy, Chromium carries WebSockets in a CONNECT tunnel.
    out.ws = await new Promise((ok) => {
      try {
        const w = new WebSocket('ws://' + location.host + '/ws');
        w.onopen = () => ok('open'); w.onerror = () => ok('error'); setTimeout(() => ok('timeout'), 5000);
      } catch (e) { ok('throw'); }
    });
    const stun = q.get('stun');
    out.candidates = await new Promise((ok) => {
      const found = [];
      try {
        const pc = new RTCPeerConnection({ iceServers: stun ? [{ urls: 'stun:' + stun }] : [] });
        pc.createDataChannel('pb');
        pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate.candidate); else ok(found); };
        pc.createOffer().then((o) => pc.setLocalDescription(o));
        setTimeout(() => ok(found), 8000);
      } catch (e) { ok(['error ' + e]); }
    });
    // Measured last: a new window may report 0x0 until it has been laid out.
    out.outer = [window.outerWidth, window.outerHeight];
  } catch (e) { out.error = String(e); }
  await fetch('/report?who=' + encodeURIComponent(out.who), { method: 'POST', body: JSON.stringify(out) });
})();
</script>"#;

#[derive(Clone, Debug)]
struct Seen {
    line: String,
    headers: Vec<(String, String)>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// The test site: serves the page, refuses the WebSocket upgrade (the request is what matters), collects reports.
struct Site {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    reports: Arc<Mutex<HashMap<String, Value>>>,
}

impl Site {
    fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let reports: Arc<Mutex<HashMap<String, Value>>> = Arc::default();
        let (s, r) = (seen.clone(), reports.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (s, r) = (s.clone(), r.clone());
                std::thread::spawn(move || serve_site(stream, &s, &r));
            }
        });
        Self {
            addr,
            seen,
            reports,
        }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn wait_report(&self, who: &str, timeout: Duration) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(v) = self.reports.lock().ok().and_then(|mut r| r.remove(who)) {
                return Some(v);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }
}

fn serve_site(stream: TcpStream, seen: &Mutex<Vec<Seen>>, reports: &Mutex<HashMap<String, Value>>) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut headers = vec![];
    let mut length = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        if let Some((n, v)) = h.trim_end().split_once(':') {
            if n.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
            headers.push((n.trim().to_owned(), v.trim().to_owned()));
        }
    }
    let mut body = vec![0u8; length.min(1 << 20)];
    let _ = reader.read_exact(&mut body);
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
    if let Ok(mut s) = seen.lock() {
        s.push(Seen {
            line: line.trim().to_owned(),
            headers,
        });
    }
    let (status, ctype, payload) = if target.starts_with("/report") {
        let who = target.split("who=").nth(1).unwrap_or("").to_owned();
        if let (Ok(v), Ok(mut r)) = (serde_json::from_slice::<Value>(&body), reports.lock()) {
            r.insert(who, v);
        }
        ("204 No Content", "text/plain", String::new())
    } else if target.starts_with("/ws") || target == "/favicon.ico" {
        ("404 Not Found", "text/plain", String::new())
    } else {
        ("200 OK", "text/html; charset=utf-8", PAGE.to_owned())
    };
    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
}

/// Counts UDP datagrams (STUN binding requests) on this computer's own network address.
struct Stun {
    addr: Option<SocketAddr>,
    packets: Arc<AtomicU64>,
}

impl Stun {
    fn start() -> Self {
        let packets = Arc::new(AtomicU64::new(0));
        // The address of the interface with the default route (connect() on UDP sends nothing).
        let ip = UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|()| s))
            .and_then(|s| s.local_addr())
            .map(|a| a.ip())
            .ok()
            .filter(|ip| !ip.is_unspecified() && !ip.is_loopback());
        let Some(ip) = ip else {
            return Self {
                addr: None,
                packets,
            };
        };
        let Ok(socket) = UdpSocket::bind(SocketAddr::new(ip, 0)) else {
            return Self {
                addr: None,
                packets,
            };
        };
        let addr = socket.local_addr().ok();
        let count = packets.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            while socket.recv_from(&mut buf).is_ok() {
                count.fetch_add(1, Ordering::Relaxed);
            }
        });
        Self { addr, packets }
    }

    fn packets(&self) -> u64 {
        self.packets.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------------------------- harness
struct Env {
    _tmp: tempfile::TempDir,
    state: Arc<AppState>,
    netlog: PathBuf,
}

fn browser() -> Option<PathBuf> {
    match std::env::var("PB_TEST_BROWSER") {
        Ok(p) if !p.is_empty() => Some(PathBuf::from(p)),
        _ => {
            assert!(
                std::env::var("PB_TEST_BROWSER_REQUIRED").is_err(),
                "PB_TEST_BROWSER is required in this run"
            );
            eprintln!("skipped: set PB_TEST_BROWSER to run real-browser tests");
            None
        }
    }
}

fn headless() -> bool {
    std::env::var("PB_TEST_SWITCHES").is_ok_and(|s| s.contains("--ozone-platform=headless"))
}

fn env() -> Option<Env> {
    let exe = browser()?;
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let netlog = tmp.path().join("netlog.json");
    let mut switches: Vec<String> = std::env::var("PB_TEST_SWITCHES")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    switches.push(format!("--log-net-log={}", netlog.display()));
    let state = AppState::build(
        &tmp.path().join("data"),
        RuntimeConfig {
            manifest: (vec![], vec![]),
            trusted_keys: pb_desktop_lib::runtime::TRUSTED_KEYS.to_owned(),
            dev_override: Some(BrowserInstall {
                executable: exe,
                revision: std::env::var("PB_TEST_BROWSER_VERSION").unwrap_or_else(|_| "dev".into()),
            }),
            fetcher: Arc::new(HttpsFetcher),
            switches,
        },
        Arc::new(SystemLauncher),
        Arc::new(SystemInspector::default()),
        Arc::new(RecordingSink::default()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    state.use_secret_store(Arc::new(MemoryStore::default()));
    state
        .create_workspace("Network tests")
        .unwrap_or_else(|e| panic!("{e:?}"));
    state
        .update_setting("proxies.allow_private_addresses", &json!(true), None)
        .unwrap_or_else(|e| panic!("{e:?}"));
    Some(Env {
        _tmp: tmp,
        state,
        netlog,
    })
}

impl Drop for Env {
    fn drop(&mut self) {
        let Ok(store) = self.state.store() else {
            return;
        };
        for id in self.state.supervisor.running_ids() {
            let _ = self.state.supervisor.force_stop(&store, &id);
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while self.state.supervisor.running_count() > 0 && Instant::now() < deadline {
            self.state.poll_once();
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Env {
    fn profile(&self, name: &str, privacy: Option<PrivacyConfig>) -> ProfileId {
        let v = self
            .state
            .create_profile(name, None, None)
            .unwrap_or_else(|e| panic!("{e:?}"));
        let id = ProfileId::parse(&v.id).unwrap_or_else(|e| panic!("{e}"));
        if let Some(p) = privacy {
            self.state
                .update_profile(
                    &id,
                    v.version,
                    ProfileChanges {
                        privacy: Some(&p),
                        ..ProfileChanges::default()
                    },
                )
                .unwrap_or_else(|e| panic!("{e:?}"));
        }
        id
    }

    fn proxy(&self, proxy: &TestProxy, login: (&str, &str)) -> ProxyId {
        let v = self
            .state
            .create_proxy(
                serde_json::from_value::<ProxyInput>(json!({
                    "name": format!("{} {}", proxy.kind.as_str(), proxy.port()),
                    "type": proxy.kind.as_str(), "host": "127.0.0.1", "port": proxy.port(),
                    "login": { "username": login.0, "password": login.1 },
                }))
                .unwrap_or_else(|e| panic!("{e}")),
            )
            .unwrap_or_else(|e| panic!("{e:?}"));
        ProxyId::parse(&v.id).unwrap_or_else(|e| panic!("{e}"))
    }

    fn assign(&self, id: &ProfileId, proxy: &ProxyId, fail_closed: bool) {
        let version = self
            .state
            .profile_status(id)
            .map(|s| s.profile.version)
            .unwrap_or_default();
        self.state
            .assign_proxy(id, Some(proxy), fail_closed, version)
            .unwrap_or_else(|e| panic!("{e:?}"));
    }

    fn wait(&self, op: &str, timeout: Duration) -> OpStatus {
        let deadline = Instant::now() + timeout;
        loop {
            self.state.poll_once();
            let st = self.state.ops.get(op).map(|o| o.status);
            if st != Some(OpStatus::Running) || Instant::now() > deadline {
                return st.unwrap_or(OpStatus::Failed);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn open(&self, id: &ProfileId, url: &str) {
        eprintln!("pb-step: open {url}");
        let op = self
            .state
            .launch_profile(id, Some(url))
            .unwrap_or_else(|e| panic!("launch: {e:?}"));
        assert_eq!(
            self.wait(&op.operation_id, Duration::from_secs(60)),
            OpStatus::Succeeded,
            "launch: {:?}",
            self.state.ops.get(&op.operation_id)
        );
    }

    fn close(&self, id: &ProfileId) {
        let op = self
            .state
            .stop_profile(id, false)
            .unwrap_or_else(|e| panic!("stop: {e:?}"));
        if self.wait(&op.operation_id, Duration::from_secs(30)) != OpStatus::Succeeded {
            let store = self.state.store().unwrap_or_else(|e| panic!("{e:?}"));
            let _ = self.state.supervisor.force_stop(&store, id);
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.state.supervisor.is_tracked(id) && Instant::now() < deadline {
            self.state.poll_once();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!self.state.supervisor.is_tracked(id), "run ended");
    }

    fn gateway_port(&self, id: &ProfileId) -> u16 {
        self.state
            .store()
            .ok()
            .and_then(|s| s.gateway_session(id).ok().flatten())
            .map(|s| s.port)
            .unwrap_or_else(|| panic!("no gateway session"))
    }

    fn network(&self, id: &ProfileId) -> Value {
        self.state
            .profile_status(id)
            .map(|s| serde_json::to_value(&s.profile.network).unwrap_or_default())
            .unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------------------------- net log
/// What Chromium's network log says about name resolution and sockets.
#[derive(Debug, Default)]
struct NetLogSummary {
    events: usize,
    /// Look-ups of the site's name that could query the network (system resolver, DNS, secure DNS, mDNS, NAT64),
    /// and resolver/DNS task events that mention it. Must be empty.
    network_lookups: Vec<String>,
    /// Look-ups of the site's name limited to the browser's cache and the hosts file (no packet is sent).
    local_only_lookups: usize,
    /// Addresses of TCP connection attempts.
    tcp: Vec<String>,
    /// UDP sockets connected to a destination (DNS or QUIC), and UDP datagrams sent.
    udp_connects: Vec<String>,
    udp_sends: usize,
}

/// Chromium's resolver task types (`HostResolverManager` task sequence): 4 = cache, 5/6 = (in)secure cache,
/// 7 = preset configuration, 9 = hosts file. Everything else can send queries.
const LOCAL_TASKS: &[u64] = &[4, 5, 6, 7, 9];

fn read_netlog(path: &Path, site: &str) -> NetLogSummary {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if let Ok(dir) = std::env::var("PB_NETLOG_KEEP") {
        let n = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
        let _ = std::fs::write(Path::new(&dir).join(format!("netlog-{n}.json")), &text);
    }
    let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| {
        // Not finalised (the browser was ended by a signal): close the list after the last complete event.
        let cut = text.rfind("},\n").map(|i| i + 1).unwrap_or(0);
        serde_json::from_str(&format!("{}]}}", &text[..cut])).unwrap_or(Value::Null)
    });
    let types: HashMap<u64, String> = parsed["constants"]["logEventTypes"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_u64().map(|n| (n, k.clone())))
                .collect()
        })
        .unwrap_or_default();
    let mut out = NetLogSummary::default();
    // The host of the latest resolver request per log source, waiting for its task sequence.
    let mut pending: HashMap<u64, String> = HashMap::new();
    for e in parsed["events"].as_array().into_iter().flatten() {
        out.events += 1;
        let name = e["type"]
            .as_u64()
            .and_then(|t| types.get(&t))
            .map(String::as_str)
            .unwrap_or("");
        let params = &e["params"];
        let source = e["source"]["id"].as_u64().unwrap_or(0);
        match name {
            "HOST_RESOLVER_MANAGER_REQUEST" => {
                if let Some(host) = params["host"].as_str() {
                    pending.insert(source, host.to_owned());
                }
            }
            "HOST_RESOLVER_MANAGER_TASK_SEQUENCE_CREATED" => {
                if let Some(host) = pending.remove(&source).filter(|h| h.contains(site)) {
                    let tasks: Vec<u64> = params["tasks"]
                        .as_array()
                        .map(|t| t.iter().filter_map(Value::as_u64).collect())
                        .unwrap_or_default();
                    if !tasks.is_empty() && tasks.iter().all(|t| LOCAL_TASKS.contains(t)) {
                        out.local_only_lookups += 1;
                    } else {
                        out.network_lookups.push(format!("{host} tasks {tasks:?}"));
                    }
                }
            }
            "TCP_CONNECT_ATTEMPT" => {
                if let Some(a) = params["address"].as_str() {
                    out.tcp.push(a.to_owned());
                }
            }
            "UDP_CONNECT" => {
                if let Some(a) = params["address"].as_str() {
                    out.udp_connects.push(a.to_owned());
                }
            }
            "UDP_BYTES_SENT" => out.udp_sends += 1,
            n if (n.starts_with("HOST_RESOLVER") || n.starts_with("DNS_"))
                && n != "HOST_RESOLVER_MANAGER_REQUEST"
                && params.to_string().contains(site) =>
            {
                out.network_lookups.push(format!("{n} {params}"));
            }
            _ => {}
        }
    }
    // A request whose task sequence was never logged is reported rather than assumed harmless.
    out.network_lookups.extend(
        pending
            .into_values()
            .filter(|h| h.contains(site))
            .map(|h| format!("{h} (no task sequence logged)")),
    );
    out
}

/// Chromium's IPv6 reachability probe: a UDP socket is *connected* (no datagram is sent; the OS only picks a route)
/// to Google Public DNS to learn whether IPv6 works.
const IPV6_PROBE: &str = "[2001:4860:4860::8888]:";

impl NetLogSummary {
    /// Asserts that no UDP datagram was sent and no UDP socket was aimed anywhere but the IPv6 probe; returns the
    /// number of probe sockets (reported as evidence).
    fn assert_no_udp(&self) -> usize {
        let other: Vec<_> = self
            .udp_connects
            .iter()
            .filter(|a| !a.starts_with(IPV6_PROBE))
            .collect();
        assert!(
            other.is_empty() && self.udp_sends == 0,
            "UDP traffic: {other:?}, datagrams sent: {}",
            self.udp_sends
        );
        self.udp_connects.len()
    }
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn evidence(test: &str, findings: Value) {
    // A workflow command: CI shows it as an annotation readable through the API.
    println!(
        "::notice title=leak evidence {} {test}::{}",
        platform(),
        findings.to_string().replace('%', "%25")
    );
}

// ---------------------------------------------------------------------------------------------- tests

/// HTTP proxy with a login, fail-closed: the page, its WebSocket and its environment, with no local DNS lookup,
/// no UDP and no WebRTC packets outside the proxy.
#[test]
fn http_proxy_fail_closed_no_dns_udp_or_webrtc_leaks() {
    let Some(env) = env() else { return };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let site = Site::start();
    let stun = Stun::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("leaktest".into(), "pw-L3ak".into())),
        hosts: [(SITE.to_owned(), site.addr)].into_iter().collect(),
        ..Default::default()
    });
    let proxy_id = env.proxy(&proxy, ("leaktest", "pw-L3ak"));
    let privacy: PrivacyConfig = serde_json::from_value(json!({
        "language": "de-DE", "timezone": "Asia/Kathmandu", "window": { "width": 1366, "height": 768 },
        "reduced_motion": true, "do_not_track": true, "webrtc": "default"
    }))
    .unwrap_or_else(|e| panic!("{e}"));
    let id = env.profile("Proxied", Some(privacy));
    env.assign(&id, &proxy_id, true);
    let stun_param = stun.addr.map(|a| a.to_string()).unwrap_or_default();
    env.open(
        &id,
        &format!("http://{SITE}/?who=proxied&stun={stun_param}"),
    );
    let gateway = env.gateway_port(&id);
    let report = site.wait_report("proxied", Duration::from_secs(60));
    std::thread::sleep(Duration::from_secs(2));
    let network = env.network(&id);
    env.close(&id);
    let report = report.unwrap_or_else(|| {
        panic!(
            "no report through the proxy; site saw {:?}; proxy log {:?}",
            site.seen(),
            proxy.log()
        )
    });
    let log = read_netlog(&env.netlog, SITE);
    let seen = site.seen();
    let proxy_log = proxy.log();

    // Through the proxy, with its login, and only there.
    assert!(
        proxy_log
            .iter()
            .any(|e| e.accepted && e.request.starts_with(&format!("GET http://{SITE}/"))),
        "{proxy_log:?}"
    );
    let ws_tunnel = proxy_log
        .iter()
        .any(|e| e.accepted && e.request == format!("CONNECT {SITE}:80"));
    assert!(
        ws_tunnel,
        "WebSocket went through a CONNECT tunnel: {proxy_log:?}"
    );
    assert!(seen.iter().any(|s| s.line.starts_with("GET /ws")));
    assert!(
        seen.iter()
            .all(|s| s.header("proxy-authorization").is_none())
    );
    // No DNS query for the site, no UDP traffic, every TCP connection to the gateway.
    assert!(log.events > 0, "the network log was written");
    assert!(
        log.network_lookups.is_empty(),
        "DNS look-ups: {:?}",
        log.network_lookups
    );
    let ipv6_probes = log.assert_no_udp();
    let gateway_addr = format!("127.0.0.1:{gateway}");
    let elsewhere: Vec<_> = log.tcp.iter().filter(|a| **a != gateway_addr).collect();
    assert!(
        elsewhere.is_empty(),
        "direct TCP connections: {elsewhere:?}"
    );
    // WebRTC: no packets to the STUN server, no candidates with this computer's addresses.
    let candidates: Vec<String> = report["candidates"]
        .as_array()
        .map(|c| {
            c.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let own_ip = stun.addr.map(|a| a.ip().to_string());
    assert!(
        candidates
            .iter()
            .all(|c| !c.contains(" srflx ") && own_ip.as_ref().is_none_or(|ip| !c.contains(ip))),
        "{candidates:?}"
    );
    assert_eq!(stun.packets(), 0, "STUN packets from a fail-closed profile");
    // Environment.
    assert_eq!(report["languages"][0], json!("de-DE"), "{report}");
    let lang_header = seen
        .iter()
        .find(|s| s.line.starts_with("GET /?"))
        .and_then(|s| s.header("accept-language").map(str::to_owned))
        .unwrap_or_default();
    assert!(lang_header.starts_with("de-DE"), "{lang_header}");
    assert!(seen.iter().any(|s| s.header("dnt") == Some("1")));
    assert_eq!(report["reduced_motion"], json!(true));
    // Website permissions: nothing is granted without the user (default "ask").
    for name in ["geolocation", "camera", "microphone"] {
        assert_ne!(report["permissions"][name], json!("granted"), "{report}");
    }
    // Kathmandu is UTC+5:45 all year; ICU may report the zone under its older alias "Asia/Katmandu".
    let kathmandu = report["offset"] == json!(-345)
        && matches!(
            report["tz"].as_str(),
            Some("Asia/Kathmandu" | "Asia/Katmandu")
        );
    if cfg!(windows) {
        assert!(!kathmandu, "documented as unavailable on Windows: {report}");
    } else {
        assert!(kathmandu, "{report}");
    }
    if headless() {
        assert_eq!(report["outer"][0], json!(1366), "{report}");
    }
    assert_eq!(network["status"], json!("active"), "{network}");
    evidence(
        "http-fail-closed",
        json!({
            "netlog_events": log.events, "dns_queries_for_site": log.network_lookups.len(),
            "cache_or_hosts_file_lookups_for_site": log.local_only_lookups,
            "udp_datagrams": log.udp_sends, "ipv6_reachability_probes_no_data": ipv6_probes,
            "tcp_attempts": log.tcp.len(), "tcp_not_to_gateway": elsewhere.len(),
            "proxy_requests": proxy_log.len(), "websocket_via_connect": ws_tunnel,
            "stun_server": stun.addr.is_some(), "stun_packets": stun.packets(), "webrtc_candidates": candidates.len(),
            "languages": report["languages"], "accept_language": lang_header, "tz": report["tz"], "utc_offset_minutes": report["offset"],
            "window": report["outer"], "reduced_motion": report["reduced_motion"],
            "permissions": report["permissions"],
        }),
    );
}

/// The control: without a proxy the same page's WebRTC does reach the STUN server, so a zero above means
/// something (when this computer has a non-loopback address).
#[test]
fn unproxied_control_profile_does_reach_the_stun_server() {
    let Some(env) = env() else { return };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let site = Site::start();
    let stun = Stun::start();
    let Some(stun_addr) = stun.addr else {
        eprintln!("skipped: no non-loopback address for the STUN control");
        return;
    };
    // The control also shows the permission defaults on a secure (localhost) page: location blocked here,
    // camera and microphone left at "ask" (a prompt, never granted silently).
    let id = env.profile("Control", None);
    let version = env
        .state
        .profile_status(&id)
        .map(|s| s.profile.version)
        .unwrap_or_default();
    env.state
        .update_profile(
            &id,
            version,
            ProfileChanges {
                location: Some("block"),
                ..ProfileChanges::default()
            },
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    env.open(
        &id,
        &format!("http://{}/?who=control&stun={stun_addr}", site.addr),
    );
    let report = site.wait_report("control", Duration::from_secs(60));
    std::thread::sleep(Duration::from_secs(2));
    env.close(&id);
    let report = report.unwrap_or_else(|| panic!("the control page did not load"));
    assert!(stun.packets() > 0, "the control profile sent STUN requests");
    let perms = &report["permissions"];
    assert_eq!(perms["geolocation"], json!("denied"), "{report}");
    assert_eq!(
        (&perms["camera"], &perms["microphone"]),
        (&json!("prompt"), &json!("prompt")),
        "{report}"
    );
    evidence(
        "control-no-proxy",
        json!({ "stun_packets": stun.packets(), "permissions": perms }),
    );
}

/// SOCKS5 with a login: the proxy resolves the site's name (the browser never does).
#[test]
fn socks5_proxy_resolves_names_remotely() {
    let Some(env) = env() else { return };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let site = Site::start();
    let proxy = TestProxy::socks5(ProxyOptions {
        login: Some(("socksuser".into(), "pw-S0cks".into())),
        hosts: [(SITE.to_owned(), site.addr)].into_iter().collect(),
        ..Default::default()
    });
    let proxy_id = env.proxy(&proxy, ("socksuser", "pw-S0cks"));
    let id = env.profile("Socks", None);
    env.assign(&id, &proxy_id, true);
    env.open(&id, &format!("http://{SITE}/?who=socks"));
    let gateway = env.gateway_port(&id);
    let report = site.wait_report("socks", Duration::from_secs(60));
    env.close(&id);
    assert!(
        report.is_some(),
        "page through SOCKS5: proxy log {:?}",
        proxy.log()
    );
    let log = read_netlog(&env.netlog, SITE);
    let proxy_log = proxy.log();
    assert!(
        proxy_log
            .iter()
            .any(|e| e.accepted && e.request == format!("SOCKS5 domain {SITE}:80")),
        "{proxy_log:?}"
    );
    assert!(log.network_lookups.is_empty(), "{:?}", log.network_lookups);
    let ipv6_probes = log.assert_no_udp();
    let gateway_addr = format!("127.0.0.1:{gateway}");
    assert!(log.tcp.iter().all(|a| *a == gateway_addr), "{:?}", log.tcp);
    evidence(
        "socks5-remote-dns",
        json!({ "netlog_events": log.events, "proxy_requests": proxy_log.len(),
                "dns_queries_for_site": log.network_lookups.len(), "udp_datagrams": log.udp_sends,
                "ipv6_reachability_probes_no_data": ipv6_probes,
                "tcp_attempts": log.tcp.len() }),
    );
}

/// The proxy is down: nothing reaches the site, nothing is looked up or connected directly, and the profile
/// shows the failure.
#[test]
fn proxy_outage_blocks_traffic_instead_of_going_direct() {
    let Some(env) = env() else { return };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let site = Site::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("down".into(), "pw-D0wn".into())),
        hosts: [(SITE.to_owned(), site.addr)].into_iter().collect(),
        ..Default::default()
    });
    let proxy_id = env.proxy(&proxy, ("down", "pw-D0wn"));
    let id = env.profile("Outage", None);
    env.assign(&id, &proxy_id, true);
    proxy.stop();
    // The page address is the site's real address: only a direct connection could reach it.
    env.open(&id, &format!("http://{}/?who=outage", site.addr));
    let gateway = env.gateway_port(&id);
    let report = site.wait_report("outage", Duration::from_secs(10));
    for _ in 0..5 {
        env.state.poll_once();
        std::thread::sleep(Duration::from_millis(200));
    }
    let network = env.network(&id);
    env.close(&id);
    assert!(report.is_none(), "the page loaded without the proxy");
    assert!(site.seen().is_empty(), "the site was contacted directly");
    let log = read_netlog(&env.netlog, &site.addr.ip().to_string());
    let gateway_addr = format!("127.0.0.1:{gateway}");
    assert!(log.tcp.iter().all(|a| *a == gateway_addr), "{:?}", log.tcp);
    let ipv6_probes = log.assert_no_udp();
    assert_eq!(
        (&network["status"], &network["last_error"]),
        (&json!("failing"), &json!("PROXY_UNREACHABLE")),
        "{network}"
    );
    evidence(
        "outage-fail-closed",
        json!({ "site_requests": 0, "tcp_attempts": log.tcp.len(), "udp_datagrams": log.udp_sends,
                "ipv6_reachability_probes_no_data": ipv6_probes, "status": network["status"],
                "error": network["last_error"] }),
    );
}

/// The user turned fail-closed off: with the proxy down the page loads directly, and the profile says so.
#[test]
fn fail_open_is_visible_when_traffic_goes_direct() {
    let Some(env) = env() else { return };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let site = Site::start();
    let proxy = TestProxy::http(ProxyOptions::default());
    let proxy_id = env.proxy(&proxy, ("open", "pw-0pen"));
    let id = env.profile("Fail open", None);
    env.assign(&id, &proxy_id, false);
    proxy.stop();
    env.open(&id, &format!("http://{}/?who=open", site.addr));
    let report = site.wait_report("open", Duration::from_secs(60));
    for _ in 0..5 {
        env.state.poll_once();
        std::thread::sleep(Duration::from_millis(200));
    }
    let network = env.network(&id);
    env.close(&id);
    assert!(report.is_some(), "the page loaded directly");
    assert_eq!(network["status"], json!("bypassing"), "{network}");
    assert!(network["direct_connections"].as_u64().unwrap_or(0) > 0);
    evidence(
        "fail-open-visible",
        json!({ "status": network["status"], "direct_connections": network["direct_connections"] }),
    );
}

/// ADR-0027: a profile that matches its proxy shows the proxy location's time zone and language to pages, and its
/// WebRTC stays on the proxy even with fail-closed off (no STUN packets from this computer's own route).
#[test]
fn matching_profile_shows_the_proxy_locations_time_zone_and_language() {
    let Some(env) = env() else { return };
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let site = Site::start();
    let stun = Stun::start();
    let check = pb_netproxy::testing::TestCheckService::start_with_body(
        "check.pb.test",
        "ip=203.0.113.7\nloc=JP\ncity=Tokyo\ntz=Asia/Tokyo\nlat=35.69\nlon=139.69\nlang=ja-JP\n",
    );
    env.state
        .set_network_settings(pb_desktop_lib::network::NetworkSettings {
            trust: check.ca.trust(),
            check: Some(pb_netproxy::check::CheckTarget {
                host: "check.pb.test".into(),
                port: 443,
                path: "/v1/netcheck".into(),
            }),
        });
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("match".into(), "pw-M4tch".into())),
        hosts: [
            (SITE.to_owned(), site.addr),
            ("check.pb.test".to_owned(), check.addr()),
        ]
        .into_iter()
        .collect(),
        ..Default::default()
    });
    let proxy_id = env.proxy(&proxy, ("match", "pw-M4tch"));
    let privacy: PrivacyConfig =
        serde_json::from_value(json!({ "match_proxy": true })).unwrap_or_else(|e| panic!("{e}"));
    let id = env.profile("Matching", Some(privacy));
    // Fail-closed off: WebRTC is kept on the proxy by matching alone.
    env.assign(&id, &proxy_id, false);
    let stun_param = stun.addr.map(|a| a.to_string()).unwrap_or_default();
    // No check yet: the launch checks first.
    env.open(
        &id,
        &format!("http://{SITE}/?who=matching&stun={stun_param}"),
    );
    let report = site.wait_report("matching", Duration::from_secs(60));
    std::thread::sleep(Duration::from_secs(2));
    env.close(&id);
    let report = report.unwrap_or_else(|| panic!("no report; proxy log {:?}", proxy.log()));
    assert_eq!(
        check.requests(),
        1,
        "the launch checked the proxy's location"
    );
    assert_eq!(report["languages"][0], json!("ja-JP"), "{report}");
    let lang_header = site
        .seen()
        .iter()
        .find(|s| s.line.starts_with("GET /?"))
        .and_then(|s| s.header("accept-language").map(str::to_owned))
        .unwrap_or_default();
    assert!(lang_header.starts_with("ja-JP"), "{lang_header}");
    // Tokyo is UTC+9 all year.
    let tokyo = report["tz"] == json!("Asia/Tokyo") && report["offset"] == json!(-540);
    if cfg!(windows) {
        assert!(!tokyo, "documented as unavailable on Windows: {report}");
    } else {
        assert!(tokyo, "{report}");
    }
    assert_eq!(stun.packets(), 0, "WebRTC stayed on the proxy");
    evidence(
        "match-proxy",
        json!({ "languages": report["languages"], "accept_language": lang_header, "tz": report["tz"],
                "utc_offset_minutes": report["offset"], "stun_packets": stun.packets(),
                "permissions": report["permissions"] }),
    );
}
