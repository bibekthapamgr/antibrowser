//! HTTPS download of runtime archives.
//!
//! - https only, also across redirects; at most 5 redirects;
//! - the system trust store is used (works behind corporate TLS inspection that the OS trusts);
//! - proxies from the standard environment variables are honoured;
//! - the body is capped at the size pinned in the signed manifest (+1 byte, so oversize is detected);
//! - a cancel flag aborts the transfer between reads.
//!
//! Integrity is NOT decided here: the installer hashes the bytes and quarantines anything that does not match.

use crate::install::ArtifactSource;
use std::io::{self, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};

/// Error text used when the transfer was cancelled by the user.
pub const CANCELLED: &str = "download cancelled";

pub struct HttpsSource {
    url: String,
    max_bytes: u64,
    cancel: Arc<AtomicBool>,
}

impl HttpsSource {
    pub fn new(url: &str, expected_size: u64, cancel: Arc<AtomicBool>) -> io::Result<Self> {
        if !url.starts_with("https://") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "only https downloads are allowed",
            ));
        }
        Ok(Self {
            url: url.to_owned(),
            max_bytes: expected_size.saturating_add(1),
            cancel,
        })
    }

    fn agent() -> ureq::Agent {
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(5)
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .timeout_recv_body(Some(Duration::from_secs(120)))
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
            .into()
    }
}

impl ArtifactSource for HttpsSource {
    fn open(&self) -> io::Result<Box<dyn Read>> {
        let response = Self::agent()
            .get(&self.url)
            .call()
            .map_err(|e| io::Error::other(format!("download failed: {e}")))?;
        let reader = response
            .into_body()
            .into_with_config()
            .limit(self.max_bytes)
            .reader();
        Ok(Box::new(Cancellable {
            inner: reader,
            cancel: self.cancel.clone(),
        }))
    }
}

struct Cancellable<R> {
    inner: R,
    cancel: Arc<AtomicBool>,
}

impl<R: Read> Read for Cancellable<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::other(CANCELLED));
        }
        self.inner.read(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_plain_http() {
        let cancel = Arc::new(AtomicBool::new(false));
        assert!(HttpsSource::new("http://example.com/x.zip", 10, cancel.clone()).is_err());
        assert!(HttpsSource::new("file:///etc/passwd", 10, cancel.clone()).is_err());
        assert!(HttpsSource::new("https://example.com/x.zip", 10, cancel).is_ok());
    }

    #[test]
    fn cancel_flag_stops_reading() {
        let cancel = Arc::new(AtomicBool::new(true));
        let mut r = Cancellable {
            inner: io::Cursor::new(vec![1u8; 10]),
            cancel,
        };
        let mut buf = [0u8; 4];
        assert_eq!(
            r.read(&mut buf).map_err(|e| e.to_string()).err().as_deref(),
            Some(CANCELLED)
        );
    }
}
