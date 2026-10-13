//! The loopback broker for debugging sessions (milestone 10, ADR-0017): lets a Playwright script on this computer
//! drive one job's browser session (`chromium.connectOverCDP(endpoint, { headers: { Authorization: 'Bearer …' } })`).
//!
//! It is off unless the person turned on "Allow Playwright connections" on this computer and an owner or admin asked
//! for a debugging job. It never exposes the browser's own DevTools: it relays one client to the protected pipe.
//! Every connection must:
//! - come to 127.0.0.1 (the listener binds loopback only, on a random port) with a `Host` of `127.0.0.1:<port>` or
//!   `localhost:<port>` (DNS rebinding) and the job's path `/cdp/<job id>`;
//! - carry no `Origin` header (web pages always send one; a script does not), so no website can reach it;
//! - present the capability: `Authorization: Bearer <secret>` whose SHA-256 is the one the job was created with
//!   (the requester generated the secret; the server and this app only ever see its digest). The first connection
//!   must arrive within the connect window; the capability ends with the job.
//!
//! One client at a time. Its command ids must stay below the app's own range; commands are counted (only the count is
//! reported).

use crate::hub::{Hub, OWN_IDS};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

#[derive(Clone, Debug)]
pub struct BrokerConfig {
    /// `job_…`: part of the path.
    pub job_id: String,
    /// SHA-256 of the capability secret (from the job).
    pub capability_sha256: [u8; 32],
    /// The first connection must come within this time.
    pub connect_within: Duration,
}

/// Why a connection was refused (for this app's local log; never sent anywhere).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Path,
    Host,
    Origin,
    Capability,
    Expired,
    Busy,
    NotWebSocket,
}

impl Refusal {
    fn status(&self) -> u16 {
        match self {
            Self::Path => 404,
            Self::Host | Self::Origin => 403,
            Self::Capability | Self::Expired => 401,
            Self::Busy => 409,
            Self::NotWebSocket => 400,
        }
    }
}

pub struct Broker {
    port: u16,
    job_id: String,
    stop: Arc<AtomicBool>,
    pub connections: Arc<AtomicU64>,
    pub refusals: Arc<Mutex<Vec<Refusal>>>,
}

impl Broker {
    pub fn start(hub: Hub, cfg: BrokerConfig) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(AtomicU64::new(0));
        let refusals = Arc::new(Mutex::new(Vec::new()));
        let deadline = Instant::now() + cfg.connect_within;
        let job_id = cfg.job_id.clone();
        let (s, c, r) = (stop.clone(), connections.clone(), refusals.clone());
        let busy = Arc::new(AtomicBool::new(false));
        std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, peer)) => {
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        let (hub, cfg, s, c, r, busy) =
                            (hub.clone(), cfg.clone(), s.clone(), c.clone(), r.clone(), busy.clone());
                        std::thread::spawn(move || {
                            if let Err(why) = serve(stream, &hub, &cfg, port, deadline, &s, &c, &busy) {
                                if let Ok(mut l) = r.lock() {
                                    l.push(why);
                                }
                            }
                        });
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(200)),
                }
            }
        });
        Ok(Self {
            port,
            job_id,
            stop,
            connections,
            refusals,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `ws://127.0.0.1:<port>/cdp/<job id>`
    pub fn endpoint(&self) -> String {
        format!("ws://127.0.0.1:{}/cdp/{}", self.port, self.job_id)
    }

    /// Stops accepting and ends the current connection (the job ended).
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn same_digest(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(clippy::too_many_arguments)]
fn serve(
    stream: TcpStream,
    hub: &Hub,
    cfg: &BrokerConfig,
    port: u16,
    deadline: Instant,
    stop: &AtomicBool,
    connections: &AtomicU64,
    busy: &AtomicBool,
) -> Result<(), Refusal> {
    stream.set_nonblocking(false).map_err(|_| Refusal::NotWebSocket)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| Refusal::NotWebSocket)?;
    let path = format!("/cdp/{}", cfg.job_id);
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let first = connections.load(Ordering::SeqCst) == 0;
    let mut refusal: Option<Refusal> = None;
    let ws = tungstenite::accept_hdr(stream, |req: &Request, resp: Response| {
        match judge(req, &path, &hosts, first, deadline, &cfg.capability_sha256) {
            None => Ok(resp),
            Some(why) => {
                let mut r = ErrorResponse::new(Some("refused".into()));
                *r.status_mut() = tungstenite::http::StatusCode::from_u16(why.status())
                    .unwrap_or(tungstenite::http::StatusCode::FORBIDDEN);
                refusal = Some(why);
                Err(r)
            }
        }
    });
    let mut ws = match ws {
        Ok(ws) => ws,
        Err(_) => return Err(refusal.unwrap_or(Refusal::NotWebSocket)),
    };
    if busy.swap(true, Ordering::SeqCst) {
        let _ = ws.close(None);
        return Err(Refusal::Busy);
    }
    let Some(rx) = hub.attach_client() else {
        busy.store(false, Ordering::SeqCst);
        let _ = ws.close(None);
        return Err(Refusal::Busy);
    };
    connections.fetch_add(1, Ordering::SeqCst);
    let _ = ws.get_mut().set_read_timeout(Some(Duration::from_millis(20)));
    relay(&mut ws, hub, &rx, stop);
    hub.detach_client();
    busy.store(false, Ordering::SeqCst);
    let _ = ws.close(None);
    let _ = ws.flush();
    Ok(())
}

/// Why a handshake is refused, or None to accept it.
fn judge(
    req: &Request,
    path: &str,
    hosts: &[String; 2],
    first: bool,
    deadline: Instant,
    capability: &[u8; 32],
) -> Option<Refusal> {
    let header = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok());
    if req.uri().path() != path {
        return Some(Refusal::Path);
    }
    if !header("host").is_some_and(|h| hosts.iter().any(|x| x == h)) {
        return Some(Refusal::Host);
    }
    if req.headers().contains_key("origin") {
        return Some(Refusal::Origin);
    }
    if first && Instant::now() > deadline {
        return Some(Refusal::Expired);
    }
    let presented = header("authorization")
        .and_then(|a| a.strip_prefix("Bearer "))
        .map(|s| Sha256::digest(s.as_bytes()));
    match presented {
        Some(d) if same_digest(&d, capability) => None,
        _ => Some(Refusal::Capability),
    }
}

fn relay(
    ws: &mut WebSocket<TcpStream>,
    hub: &Hub,
    rx: &std::sync::mpsc::Receiver<String>,
    stop: &AtomicBool,
) {
    loop {
        if stop.load(Ordering::SeqCst) || hub.is_closed() {
            return;
        }
        // From the browser to the client.
        while let Ok(text) = rx.try_recv() {
            if ws.send(Message::text(text)).is_err() {
                return;
            }
        }
        // From the client to the browser.
        match ws.read() {
            Ok(Message::Text(t)) => {
                let text = t.as_str();
                let id_ok = serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|v| v.get("id").and_then(Value::as_u64))
                    .is_some_and(|id| id < OWN_IDS);
                if !id_ok {
                    return;
                }
                if hub.send_raw(text).is_err() {
                    return;
                }
                hub.count_relayed();
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
    }
}
