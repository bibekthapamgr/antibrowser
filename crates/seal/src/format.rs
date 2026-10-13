//! The sealed container (scheme `aes-256-gcm-chunked-v1`, ADR-0014).
//!
//! ```text
//! "PBSEAL" 0x00 0x01 | header length (u32, big endian) | header (JSON) | chunk 0 | chunk 1 | ... | last chunk
//! ```
//!
//! The payload is encrypted with STREAM (Hoang, Reyhanitabar, Rogaway, Vizár, "Online Authenticated-Encryption and
//! its Nonce-Reuse Misuse-Resistance", 2015) over AES-256-GCM, as implemented by RustCrypto (`aead-stream`
//! `StreamBE32`): every chunk's nonce is a 7-byte random prefix, a 32-bit big-endian chunk counter and a last-chunk
//! flag. Every chunk is authenticated together with the complete prefix above (magic, length and header) as
//! associated data. Every chunk except the last carries exactly [`CHUNK`] plaintext bytes; the last carries the rest
//! (possibly nothing). Consequences:
//!  - a changed header (other organization, profile, snapshot, key version...) fails authentication;
//!  - truncation, reordering, dropping or repeating chunks, and splicing chunks between files fail authentication;
//!  - each data key is fresh per file and the nonce prefix is random, so no (key, nonce) pair repeats.
//!
//! Nothing here invents cryptography: AES-256-GCM and STREAM come from audited, widely used RustCrypto crates.

use aead_stream::{DecryptorBE32, EncryptorBE32, NewStream as _, StreamBE32};
use aes_gcm::{Aes256Gcm, KeyInit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use zeroize::Zeroizing;

use crate::SealError;

pub const MAGIC: &[u8; 8] = b"PBSEAL\x00\x01";
pub const SCHEME: &str = "aes-256-gcm-chunked-v1";
/// Plaintext bytes per chunk (the last chunk may be shorter).
pub const CHUNK: usize = 1 << 20;
/// The archive layout inside the payload (see `archive`). Openers refuse versions they do not know.
pub const SCHEMA_VERSION: u32 = 1;
const TAG: usize = 16;
const NONCE_PREFIX: usize = 7;
const MAX_HEADER: usize = 16 * 1024;

/// What a sealed file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// An organization profile snapshot (key wrapped by the organization key, milestone 07).
    OrgSnapshot,
    /// A local last-good backup (key held in this device's keychain).
    LocalBackup,
}

/// Who and what the file belongs to. Written into the header and checked again when opening.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub kind: Kind,
    pub org_id: Option<String>,
    pub profile_id: String,
    /// Snapshot id (organization snapshots) or backup id (local backups).
    pub object_id: String,
    /// Organization key version (organization snapshots) or `device` (local backups).
    pub key_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub scheme: String,
    pub kind: Kind,
    pub org_id: Option<String>,
    pub profile_id: String,
    pub object_id: String,
    pub schema_version: u32,
    pub key_version: String,
    pub chunk_size: u32,
    /// Hex, 7 random bytes.
    pub nonce_prefix: String,
}

impl Header {
    fn check(&self, expect: &Binding) -> Result<(), SealError> {
        let mismatch = |field: &'static str| Err(SealError::HeaderMismatch(field));
        if self.scheme != SCHEME {
            return Err(SealError::UnsupportedFormat);
        }
        if self.schema_version != SCHEMA_VERSION {
            return Err(SealError::UnsupportedFormat);
        }
        if self.chunk_size as usize != CHUNK {
            return Err(SealError::UnsupportedFormat);
        }
        if self.kind != expect.kind {
            return mismatch("kind");
        }
        if self.org_id != expect.org_id {
            return mismatch("org_id");
        }
        if self.profile_id != expect.profile_id {
            return mismatch("profile_id");
        }
        if self.object_id != expect.object_id {
            return mismatch("object_id");
        }
        if self.key_version != expect.key_version {
            return mismatch("key_version");
        }
        Ok(())
    }
}

/// A 256-bit data key. Wiped from memory when dropped; never printed.
#[derive(Clone)]
pub struct SealKey(Zeroizing<[u8; 32]>);

impl SealKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    pub fn from_slice(bytes: &[u8]) -> Result<Self, SealError> {
        let arr: [u8; 32] = bytes.try_into().map_err(|_| SealError::BadKey)?;
        Ok(Self::from_bytes(arr))
    }
    /// A fresh random key (operating system randomness).
    pub fn generate() -> Result<Self, SealError> {
        let mut k = Zeroizing::new([0u8; 32]);
        getrandom::fill(&mut k[..]).map_err(|_| SealError::Randomness)?;
        Ok(Self(k))
    }
    pub fn from_base64(s: &str) -> Result<Self, SealError> {
        use base64::Engine as _;
        let bytes = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|_| SealError::BadKey)?,
        );
        Self::from_slice(&bytes)
    }
    pub fn to_base64(&self) -> Zeroizing<String> {
        use base64::Engine as _;
        Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&self.0[..]))
    }
    /// A short public identifier of this key (16 hex characters of a domain-separated SHA-256), so a file sealed
    /// with another key can be reported as "key not available" rather than "damaged". Reveals nothing usable about
    /// the key itself.
    pub fn fingerprint(&self) -> String {
        let mut h = Sha256::new();
        h.update(b"pb-seal-key-fingerprint-v1\0");
        h.update(&self.0[..]);
        hex::encode(&h.finalize()[..8])
    }
    fn cipher(&self) -> Aes256Gcm {
        let key: &aes_gcm::Key<Aes256Gcm> = (&*self.0).into();
        Aes256Gcm::new(key)
    }
}

impl std::fmt::Debug for SealKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SealKey(..)")
    }
}

fn io_err(e: SealError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e)
}

/// Encrypts everything written to it into the sealed container. Call [`SealWriter::finish`] at the end: without it the
/// file has no last chunk and will not open.
pub struct SealWriter<W: Write> {
    inner: W,
    enc: Option<EncryptorBE32<Aes256Gcm>>,
    aad: Vec<u8>,
    buf: Vec<u8>,
    plaintext: u64,
}

impl<W: Write> SealWriter<W> {
    pub fn new(mut inner: W, key: &SealKey, binding: &Binding) -> Result<Self, SealError> {
        let mut prefix = [0u8; NONCE_PREFIX];
        getrandom::fill(&mut prefix).map_err(|_| SealError::Randomness)?;
        let header = Header {
            scheme: SCHEME.to_owned(),
            kind: binding.kind,
            org_id: binding.org_id.clone(),
            profile_id: binding.profile_id.clone(),
            object_id: binding.object_id.clone(),
            schema_version: SCHEMA_VERSION,
            key_version: binding.key_version.clone(),
            chunk_size: CHUNK as u32,
            nonce_prefix: hex::encode(prefix),
        };
        let json = serde_json::to_vec(&header).map_err(|_| SealError::UnsupportedFormat)?;
        if json.len() > MAX_HEADER {
            return Err(SealError::UnsupportedFormat);
        }
        let mut aad = Vec::with_capacity(12 + json.len());
        aad.extend_from_slice(MAGIC);
        aad.extend_from_slice(&(json.len() as u32).to_be_bytes());
        aad.extend_from_slice(&json);
        inner.write_all(&aad)?;
        let enc = EncryptorBE32::from_stream_primitive(StreamBE32::from_aead(
            key.cipher(),
            (&prefix).into(),
        ));
        Ok(Self {
            inner,
            enc: Some(enc),
            aad,
            buf: Vec::with_capacity(CHUNK * 2),
            plaintext: 0,
        })
    }

    /// Writes the last chunk and returns the inner writer and the number of plaintext bytes.
    pub fn finish(mut self) -> Result<(W, u64), SealError> {
        let enc = self.enc.take().ok_or(SealError::UnsupportedFormat)?;
        let mut last = std::mem::take(&mut self.buf);
        enc.encrypt_last_in_place(&self.aad, &mut last)
            .map_err(|_| SealError::Authentication)?;
        self.inner.write_all(&last)?;
        self.inner.flush()?;
        Ok((self.inner, self.plaintext))
    }
}

impl<W: Write> Write for SealWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        self.plaintext += data.len() as u64;
        // A full chunk is sealed only once more data follows it, so the final chunk is always the one marked last.
        while self.buf.len() > CHUNK {
            let enc = self
                .enc
                .as_mut()
                .ok_or_else(|| io_err(SealError::UnsupportedFormat))?;
            let mut chunk: Vec<u8> = self.buf.drain(..CHUNK).collect();
            enc.encrypt_next_in_place(&self.aad, &mut chunk)
                .map_err(|_| io_err(SealError::Authentication))?;
            self.inner.write_all(&chunk)?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Reads the header of a sealed stream without a key (for diagnostics and pre-checks).
pub fn read_header<R: Read>(inner: &mut R) -> Result<(Header, Vec<u8>), SealError> {
    let mut magic = [0u8; 8];
    inner
        .read_exact(&mut magic)
        .map_err(|_| SealError::UnsupportedFormat)?;
    if &magic != MAGIC {
        return Err(SealError::UnsupportedFormat);
    }
    let mut len = [0u8; 4];
    inner
        .read_exact(&mut len)
        .map_err(|_| SealError::UnsupportedFormat)?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_HEADER {
        return Err(SealError::UnsupportedFormat);
    }
    let mut json = vec![0u8; len];
    inner
        .read_exact(&mut json)
        .map_err(|_| SealError::UnsupportedFormat)?;
    let header: Header = serde_json::from_slice(&json).map_err(|_| SealError::UnsupportedFormat)?;
    let mut aad = Vec::with_capacity(12 + len);
    aad.extend_from_slice(&magic);
    aad.extend_from_slice(&(len as u32).to_be_bytes());
    aad.extend_from_slice(&json);
    Ok((header, aad))
}

/// Decrypts a sealed stream. Fails closed: any authentication failure is an error, and the stream reports its end only
/// after the chunk marked last has been authenticated.
pub struct SealReader<R: Read> {
    inner: R,
    dec: Option<DecryptorBE32<Aes256Gcm>>,
    aad: Vec<u8>,
    out: Vec<u8>,
    pos: usize,
    lookahead: Option<u8>,
    done: bool,
}

impl<R: Read> SealReader<R> {
    pub fn open(
        mut inner: R,
        key: &SealKey,
        expect: &Binding,
    ) -> Result<(Self, Header), SealError> {
        let (header, aad) = read_header(&mut inner)?;
        header.check(expect)?;
        let prefix: [u8; NONCE_PREFIX] = hex::decode(&header.nonce_prefix)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or(SealError::UnsupportedFormat)?;
        let dec = DecryptorBE32::from_stream_primitive(StreamBE32::from_aead(
            key.cipher(),
            (&prefix).into(),
        ));
        Ok((
            Self {
                inner,
                dec: Some(dec),
                aad,
                out: Vec::new(),
                pos: 0,
                lookahead: None,
                done: false,
            },
            header,
        ))
    }

    fn next_chunk(&mut self) -> io::Result<()> {
        let want = CHUNK + TAG;
        let mut ct = Vec::with_capacity(want);
        if let Some(b) = self.lookahead.take() {
            ct.push(b);
        }
        let mut limited = (&mut self.inner).take((want - ct.len()) as u64);
        limited.read_to_end(&mut ct)?;
        let last = if ct.len() < want {
            true
        } else {
            let mut one = [0u8; 1];
            loop {
                match self.inner.read(&mut one) {
                    Ok(0) => break true,
                    Ok(_) => {
                        self.lookahead = Some(one[0]);
                        break false;
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e),
                }
            }
        };
        if ct.len() < TAG {
            return Err(io_err(SealError::Authentication));
        }
        if last {
            let dec = self
                .dec
                .take()
                .ok_or_else(|| io_err(SealError::Authentication))?;
            dec.decrypt_last_in_place(&self.aad, &mut ct)
                .map_err(|_| io_err(SealError::Authentication))?;
            self.done = true;
        } else {
            let dec = self
                .dec
                .as_mut()
                .ok_or_else(|| io_err(SealError::Authentication))?;
            dec.decrypt_next_in_place(&self.aad, &mut ct)
                .map_err(|_| io_err(SealError::Authentication))?;
        }
        self.out = ct;
        self.pos = 0;
        Ok(())
    }
}

impl<R: Read> Read for SealReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.pos >= self.out.len() {
            if self.done {
                return Ok(0);
            }
            self.next_chunk()?;
        }
        let n = buf.len().min(self.out.len() - self.pos);
        buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Counts and hashes everything written through it (the server verifies the same SHA-256 over the stored object).
pub struct Hashing<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> Hashing<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }
    pub fn finish(self) -> (W, String, u64) {
        (self.inner, hex::encode(self.hasher.finalize()), self.bytes)
    }
}

impl<W: Write> Write for Hashing<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(data)?;
        self.hasher.update(&data[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// SHA-256 (hex) and length of a file.
pub fn digest_reader<R: Read>(mut r: R) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}
