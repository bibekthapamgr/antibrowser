//! Encrypted snapshot transfer to and from object storage through short-lived signed URLs (milestone 07).
//!
//! - Only sealed (encrypted, authenticated) bytes travel here; the URLs are issued by the API per part or object and
//!   expire within minutes. No `Authorization` header is ever sent to storage.
//! - The same address rules as the API: https, or plain http to a loopback address when allowed (a developer's local
//!   storage or an SSH tunnel). Redirects are not followed.
//! - Downloads resume with an HTTP `Range` request; a server that ignores the range restarts from byte 0.

use crate::http::{HttpError, is_loopback};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransferError {
    #[error(transparent)]
    Http(#[from] HttpError),
    /// The signed URL expired or was refused (403): ask the API for a new one.
    #[error("the transfer link expired")]
    Expired,
    /// Storage answered with an unexpected status.
    #[error("storage answered {0}")]
    Status(u16),
    #[error("the transfer was cancelled")]
    Cancelled,
    #[error("local file error")]
    Io,
}

pub struct Transfer {
    agent: ureq::Agent,
    allow_loopback_http: bool,
}

/// Download progress is reported after every chunk of this size.
const CHUNK: usize = 1 << 20;

impl Transfer {
    pub fn new(allow_loopback_http: bool) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(120)))
            // One 16 MiB part on a slow uplink; whole snapshots on a slow downlink.
            .timeout_send_body(Some(Duration::from_secs(30 * 60)))
            .timeout_recv_body(Some(Duration::from_secs(12 * 60 * 60)))
            .user_agent(concat!(
                "project-browser-manager/",
                env!("CARGO_PKG_VERSION")
            ))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .into();
        Self {
            agent,
            allow_loopback_http,
        }
    }

    fn check(&self, raw: &str) -> Result<Url, TransferError> {
        let url = Url::parse(raw).map_err(|_| HttpError::BadUrl)?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(HttpError::BadUrl.into());
        }
        match url.scheme() {
            "https" if url.host().is_some() => Ok(url),
            "http" if self.allow_loopback_http && is_loopback(&url) => Ok(url),
            "http" | "https" => Err(HttpError::Insecure.into()),
            _ => Err(HttpError::BadUrl.into()),
        }
    }

    /// Uploads one part to its signed URL; returns the storage's ETag (unquoted).
    pub fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, TransferError> {
        let url = self.check(url)?;
        let res = self
            .agent
            .put(url.as_str())
            .content_type("application/octet-stream")
            .send(bytes)
            .map_err(classify)?;
        let status = res.status().as_u16();
        match status {
            200 | 201 => {}
            403 => return Err(TransferError::Expired),
            s => return Err(TransferError::Status(s)),
        }
        let etag = res
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|v| {
                v.trim()
                    .trim_start_matches("W/")
                    .trim_matches('"')
                    .to_owned()
            })
            .filter(|v| !v.is_empty())
            .ok_or(TransferError::Status(status))?;
        Ok(etag)
    }

    /// Downloads from byte `start` to the end of the object, appending to `out`. Returns the offset reached (the
    /// object size when complete). `restart` is called (and `out` must be truncated by the caller) when the server
    /// ignores the range and sends the whole object: the returned offset then counts from 0.
    pub fn download(
        &self,
        url: &str,
        start: u64,
        out: &mut dyn Write,
        restart: &mut dyn FnMut() -> io::Result<()>,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64, TransferError> {
        let url = self.check(url)?;
        let mut req = self.agent.get(url.as_str());
        if start > 0 {
            req = req.header("range", format!("bytes={start}-"));
        }
        let res = req.call().map_err(classify)?;
        let mut offset = match res.status().as_u16() {
            206 => start,
            200 => {
                if start > 0 {
                    restart().map_err(|_| TransferError::Io)?;
                }
                0
            }
            // The local part is already the whole object.
            416 => return Ok(start),
            403 => return Err(TransferError::Expired),
            s => return Err(TransferError::Status(s)),
        };
        let mut reader = res.into_body().into_reader();
        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(TransferError::Cancelled);
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(HttpError::Offline.into()),
            };
            out.write_all(&buf[..n]).map_err(|_| TransferError::Io)?;
            offset += n as u64;
            progress(offset);
        }
        out.flush().map_err(|_| TransferError::Io)?;
        Ok(offset)
    }
}

fn classify(e: ureq::Error) -> TransferError {
    TransferError::Http(match e {
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed => HttpError::Offline,
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => HttpError::Tls,
        ureq::Error::BadUri(_) => HttpError::BadUrl,
        _ => HttpError::Other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn signed_urls_must_be_https_or_allowed_loopback() {
        let strict = Transfer::new(false);
        let dev = Transfer::new(true);
        assert!(
            strict
                .check("https://s3.example.test/b/k?X-Amz-Signature=1")
                .is_ok()
        );
        assert_eq!(
            strict.check("http://127.0.0.1:8333/b/k").err(),
            Some(TransferError::Http(HttpError::Insecure))
        );
        assert!(dev.check("http://127.0.0.1:8333/b/k").is_ok());
        assert_eq!(
            dev.check("http://10.1.2.3:8333/b/k").err(),
            Some(TransferError::Http(HttpError::Insecure))
        );
        assert_eq!(
            dev.check("https://u:p@s3.example.test/b/k").err(),
            Some(TransferError::Http(HttpError::BadUrl))
        );
        assert_eq!(
            dev.check("file:///etc/passwd").err(),
            Some(TransferError::Http(HttpError::BadUrl))
        );
    }

    /// A one-shot HTTP server answering each request with the next canned response; returns the requests seen.
    fn serve(responses: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        let handle = std::thread::spawn(move || {
            let mut seen = vec![];
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut reader =
                    BufReader::new(stream.try_clone().unwrap_or_else(|e| panic!("{e}")));
                let mut head = String::new();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    head.push_str(&line);
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                seen.push(head);
                let _ = stream.write_all(&response);
            }
            seen
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn put_part_returns_the_unquoted_etag_and_maps_expiry() {
        let (base, server) = serve(vec![
            b"HTTP/1.1 200 OK\r\nETag: \"abc123\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ]);
        let t = Transfer::new(true);
        assert_eq!(
            t.put_part(&format!("{base}/b/k?part=1"), b"sealed"),
            Ok("abc123".into())
        );
        assert_eq!(
            t.put_part(&format!("{base}/b/k?part=2"), b"sealed"),
            Err(TransferError::Expired)
        );
        let seen = server.join().unwrap_or_default();
        assert!(seen[0].starts_with("PUT /b/k?part=1 "));
        assert!(!seen[0].to_ascii_lowercase().contains("authorization"));
    }

    #[test]
    fn downloads_resume_with_a_range_and_restart_when_it_is_ignored() {
        let (base, server) = serve(vec![
            b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nConnection: close\r\n\r\ndef"
                .to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef".to_vec(),
        ]);
        let t = Transfer::new(true);
        let never = AtomicBool::new(false);
        let mut out = b"abc".to_vec();
        let end = t.download(
            &format!("{base}/o"),
            3,
            &mut out,
            &mut || Ok(()),
            &never,
            &mut |_| {},
        );
        assert_eq!(end, Ok(6));
        assert_eq!(out, b"abcdef");

        let mut out = b"abX".to_vec();
        let mut restarted = false;
        let end = {
            let out_ref = &mut out;
            let mut sink = Vec::new();
            let r = t.download(
                &format!("{base}/o"),
                3,
                &mut sink,
                &mut || {
                    restarted = true;
                    Ok(())
                },
                &never,
                &mut |_| {},
            );
            out_ref.clear();
            out_ref.extend_from_slice(&sink);
            r
        };
        assert_eq!(end, Ok(6));
        assert!(restarted);
        assert_eq!(out, b"abcdef");
        let seen = server.join().unwrap_or_default();
        assert!(seen[0].to_ascii_lowercase().contains("range: bytes=3-"));
    }
}
