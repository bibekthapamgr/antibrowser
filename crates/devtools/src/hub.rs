//! One DevTools connection over the pipe, shared by this app's own steps and (for a debugging session) one relayed
//! client. Messages are JSON terminated by a NUL byte.
//!
//! Routing: this app's commands use ids from 2^30 upwards (Chromium reads ids as 32-bit integers); a relayed client's
//! ids are its own (smaller). Answers go back to whoever asked; events go to this app's listeners and to the relayed
//! client, if any.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The first id this app uses; anything below belongs to a relayed client. Ids stay below 2^31.
pub const OWN_IDS: u64 = 1 << 30;
/// Largest message accepted from the browser (screenshots are the big ones).
const MAX_MESSAGE: usize = 32 * 1024 * 1024;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum CdpError {
    #[error("the browser closed the connection")]
    Closed,
    #[error("no answer in time")]
    Timeout,
    #[error("the browser refused the command ({code}): {message}")]
    Protocol { code: i64, message: String },
}

#[derive(Clone, Debug)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

type Pending = Mutex<HashMap<u64, Sender<Result<Value, CdpError>>>>;

struct Shared {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Pending,
    listeners: Mutex<Vec<Sender<Event>>>,
    client: Mutex<Option<Sender<String>>>,
    next: AtomicU64,
    closed: AtomicBool,
    relayed: AtomicU64,
}

/// A DevTools connection. Cheap to clone.
#[derive(Clone)]
pub struct Hub {
    shared: Arc<Shared>,
}

impl Hub {
    /// Starts reading answers and events from `reader` on a background thread.
    pub fn new(reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>) -> Self {
        let shared = Arc::new(Shared {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            listeners: Mutex::new(Vec::new()),
            client: Mutex::new(None),
            next: AtomicU64::new(OWN_IDS),
            closed: AtomicBool::new(false),
            relayed: AtomicU64::new(0),
        });
        let s = shared.clone();
        std::thread::spawn(move || read_loop(&s, reader));
        Self { shared }
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    /// Sends a command (to a target session when `session` is set) and waits for its answer.
    pub fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        if self.is_closed() {
            return Err(CdpError::Closed);
        }
        let id = self.shared.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        if let Ok(mut p) = self.shared.pending.lock() {
            p.insert(id, tx);
        }
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let (Some(s), Some(obj)) = (session, msg.as_object_mut()) {
            obj.insert("sessionId".into(), Value::String(s.to_owned()));
        }
        if self.send_raw(&msg.to_string()).is_err() {
            self.forget(id);
            return Err(CdpError::Closed);
        }
        let out = rx.recv_timeout(timeout).map_err(|e| match e {
            std::sync::mpsc::RecvTimeoutError::Timeout => CdpError::Timeout,
            std::sync::mpsc::RecvTimeoutError::Disconnected => CdpError::Closed,
        });
        self.forget(id);
        out?
    }

    fn forget(&self, id: u64) {
        if let Ok(mut p) = self.shared.pending.lock() {
            p.remove(&id);
        }
    }

    /// Writes one message (NUL-terminated).
    pub fn send_raw(&self, text: &str) -> std::io::Result<()> {
        let mut w = self
            .shared
            .writer
            .lock()
            .map_err(|_| std::io::Error::other("writer poisoned"))?;
        w.write_all(text.as_bytes())?;
        w.write_all(&[0])?;
        w.flush()
    }

    /// Receives every event from now on (until the receiver is dropped).
    pub fn events(&self) -> Receiver<Event> {
        let (tx, rx) = channel();
        if let Ok(mut l) = self.shared.listeners.lock() {
            l.push(tx);
        }
        rx
    }

    /// Relays a client: its messages are passed through unchanged, answers to its ids and every event come back on
    /// the returned receiver. One client at a time; `None` when one is already connected.
    pub fn attach_client(&self) -> Option<Receiver<String>> {
        let mut c = self.shared.client.lock().ok()?;
        if c.as_ref().is_some() {
            return None;
        }
        let (tx, rx) = channel();
        *c = Some(tx);
        Some(rx)
    }

    pub fn detach_client(&self) {
        if let Ok(mut c) = self.shared.client.lock() {
            *c = None;
        }
    }

    /// Counts a command relayed for a client (reported as a number only).
    pub fn count_relayed(&self) {
        self.shared.relayed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn relayed(&self) -> u64 {
        self.shared.relayed.load(Ordering::Relaxed)
    }
}

fn read_loop(s: &Shared, reader: Box<dyn Read + Send>) {
    let mut r = BufReader::with_capacity(1 << 16, reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(0, &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.last() == Some(&0) {
            buf.pop();
        }
        if buf.is_empty() || buf.len() > MAX_MESSAGE {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&buf) else {
            continue;
        };
        route(s, text);
    }
    s.closed.store(true, Ordering::SeqCst);
    if let Ok(mut p) = s.pending.lock() {
        for (_, tx) in p.drain() {
            let _ = tx.send(Err(CdpError::Closed));
        }
    }
    if let Ok(mut l) = s.listeners.lock() {
        l.clear();
    }
    if let Ok(mut c) = s.client.lock() {
        *c = None;
    }
}

fn route(s: &Shared, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if let Some(id) = v.get("id").and_then(Value::as_u64) {
        if id >= OWN_IDS {
            let tx = s.pending.lock().ok().and_then(|mut p| p.remove(&id));
            if let Some(tx) = tx {
                let result = match v.get("error") {
                    Some(e) => Err(CdpError::Protocol {
                        code: e.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: e
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .chars()
                            .take(200)
                            .collect(),
                    }),
                    None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
        } else if let Ok(c) = s.client.lock()
            && let Some(tx) = c.as_ref()
        {
            let _ = tx.send(text.to_owned());
        }
        return;
    }
    // An event: to this app's listeners and to the relayed client.
    if let Some(method) = v.get("method").and_then(Value::as_str) {
        let event = Event {
            method: method.to_owned(),
            params: v.get("params").cloned().unwrap_or(Value::Null),
            session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        };
        if let Ok(mut l) = s.listeners.lock() {
            l.retain(|tx| tx.send(event.clone()).is_ok());
        }
        if let Ok(c) = s.client.lock()
            && let Some(tx) = c.as_ref()
        {
            let _ = tx.send(text.to_owned());
        }
    }
}
