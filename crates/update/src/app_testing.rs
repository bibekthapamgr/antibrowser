//! Test support for other crates (feature `testing`): throwaway release keys in the Tauri signature format, signed
//! channel manifests and an in-memory release host. Never compiled into the app.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;

/// A throwaway minisign key pair, as `tauri signer generate` makes them.
pub struct TestKey {
    kp: minisign::KeyPair,
    pub public_key_b64: String,
    pub key_id: String,
}

impl Default for TestKey {
    fn default() -> Self {
        Self::generate()
    }
}

impl TestKey {
    pub fn generate() -> Self {
        let kp = minisign::KeyPair::generate_unencrypted_keypair().expect("keypair");
        let text = kp.pk.to_box().expect("pk box").to_string();
        let line = text.lines().nth(1).expect("key line").to_owned();
        Self {
            key_id: key_id_of(&line).expect("key id"),
            public_key_b64: B64.encode(text),
            kp,
        }
    }

    /// A Tauri-format signature (base64 of the minisign signature text) with this trusted comment.
    pub fn sign(&self, data: &[u8], trusted_comment: &str) -> String {
        let sb = minisign::sign(
            Some(&self.kp.pk),
            &self.kp.sk,
            Cursor::new(data),
            Some(trusted_comment),
            Some("signature from tauri secret key"),
        )
        .expect("sign");
        B64.encode(sb.to_string())
    }

    /// Signs an artifact the way the release job does (`tauri signer sign --app-version`).
    pub fn sign_artifact(&self, data: &[u8], file: &str, version: &str, now: i64) -> String {
        self.sign(
            data,
            &format!("timestamp:{now}\tfile:{file}\tversion:{version}"),
        )
    }

    /// Signs a channel manifest the way the release job does.
    pub fn sign_manifest(&self, body: &[u8], channel: &str, now: i64) -> String {
        self.sign(body, &format!("timestamp:{now}\tfile:{channel}.json"))
    }

    /// `release-keys.json` trusting this key from `not_before` to `not_after`.
    pub fn keys_json(&self, not_before: &str, not_after: &str) -> String {
        serde_json::json!({ "keys": [{
            "key_id": self.key_id,
            "public_key": self.public_key_b64,
            "not_before": not_before,
            "not_after": not_after,
            "note": "test key"
        }] })
        .to_string()
    }
}

/// An in-memory release host: files by URL, with an optional interruption of the next download.
#[derive(Default)]
pub struct MemHost {
    files: Mutex<HashMap<String, Vec<u8>>>,
    fail_after: Mutex<Option<usize>>,
    /// Offsets asked for by each download request (0 = from the start).
    pub opens: Mutex<Vec<u64>>,
}

impl MemHost {
    pub fn put(&self, url: &str, bytes: Vec<u8>) {
        self.files
            .lock()
            .expect("lock")
            .insert(url.to_owned(), bytes);
    }

    pub fn remove(&self, url: &str) {
        self.files.lock().expect("lock").remove(url);
    }

    /// Publishes a manifest and its signature for a channel.
    pub fn publish(&self, channel: &str, body: Vec<u8>, sig: String) {
        self.put(&manifest_url(channel), body);
        self.put(&signature_url(channel), sig.into_bytes());
    }

    /// The next download breaks after `n` bytes (a dropped connection).
    pub fn interrupt_next_after(&self, n: usize) {
        *self.fail_after.lock().expect("lock") = Some(n);
    }

    pub fn opens(&self) -> Vec<u64> {
        self.opens.lock().expect("lock").clone()
    }
}

struct Interrupted {
    inner: Cursor<Vec<u8>>,
    left: usize,
}

impl Read for Interrupted {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection reset",
            ));
        }
        let n = buf.len().min(self.left);
        let got = self.inner.read(&mut buf[..n])?;
        self.left -= got;
        Ok(got)
    }
}

impl Transport for MemHost {
    fn get(&self, url: &str, max_bytes: u64) -> io::Result<Vec<u8>> {
        let b = self
            .files
            .lock()
            .expect("lock")
            .get(url)
            .cloned()
            .ok_or_else(|| io::Error::other("404"))?;
        if b.len() as u64 > max_bytes {
            return Err(io::Error::other("too large"));
        }
        Ok(b)
    }

    fn open_from(&self, url: &str, offset: u64) -> io::Result<(Box<dyn Read + Send>, u64)> {
        self.opens.lock().expect("lock").push(offset);
        let b = self
            .files
            .lock()
            .expect("lock")
            .get(url)
            .cloned()
            .ok_or_else(|| io::Error::other("404"))?;
        let start = (offset as usize).min(b.len());
        let body = b[start..].to_vec();
        if let Some(n) = self.fail_after.lock().expect("lock").take() {
            return Ok((
                Box::new(Interrupted {
                    inner: Cursor::new(body),
                    left: n,
                }),
                start as u64,
            ));
        }
        Ok((Box::new(Cursor::new(body)), start as u64))
    }
}

/// A `.app.tar.gz` of a minimal manager bundle (`Project Browser.app`) with this bundle id and version.
pub fn app_bundle_archive(bundle_id: &str, version: &str) -> Vec<u8> {
    let plist = format!(
        "<?xml version=\"1.0\"?><plist><dict>\n<key>CFBundleIdentifier</key>\n<string>{bundle_id}</string>\n\
         <key>CFBundleShortVersionString</key>\n<string>{version}</string>\n</dict></plist>"
    );
    let exe = format!("#!/bin/sh\necho {version}\n");
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    for dir in [
        "Project Browser.app/",
        "Project Browser.app/Contents/",
        "Project Browser.app/Contents/MacOS/",
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Directory);
        h.set_size(0);
        h.set_mode(0o755);
        h.set_cksum();
        b.append_data(&mut h, dir, &[][..]).expect("dir");
    }
    for (path, content) in [
        ("Project Browser.app/Contents/Info.plist", plist.as_str()),
        (
            "Project Browser.app/Contents/MacOS/pb-desktop",
            exe.as_str(),
        ),
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Regular);
        h.set_size(content.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        b.append_data(&mut h, path, content.as_bytes())
            .expect("file");
    }
    b.into_inner().expect("tar").finish().expect("gz")
}
