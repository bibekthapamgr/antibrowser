//! Cross-device session carry for workspace profiles (ADR-0028, supersedes the "sessions do not travel" line of
//! ADR-0002).
//!
//! Chromium encrypts each cookie's value at rest with a key held by the source computer's OS (a login-Keychain
//! item on macOS, a DPAPI-protected per-profile key on Windows, a password store on Linux). That key never leaves
//! the computer, so a sealed snapshot restored on a teammate's computer kept the cookie *rows* but not their usable
//! values: the teammate was asked to sign in again.
//!
//! This module carries a workspace profile's OWN stored sessions across enrolled devices of the same workspace,
//! at the owner's request, without weakening anything:
//!
//! - [`collect_portable`] runs when a workspace profile is sealed. It reads the profile's Chromium cookie store and
//!   decrypts each value with the SOURCE computer's own cookie key (the same key the browser itself uses), yielding
//!   an opaque plaintext blob per cookie. It returns those blobs as the snapshot's `cookies.json` member. That
//!   member is sealed inside the EXISTING end-to-end-encrypted snapshot, under the workspace's own snapshot key —
//!   the caller never writes it to disk in the clear, and this function never writes anything itself.
//! - [`restore_portable`] runs right after such a snapshot is opened into a closed profile on the destination
//!   computer. It re-encrypts each carried blob under THIS computer's own Chromium cookie key and writes the result
//!   back into the restored cookie store, so the browser opens already signed in.
//!
//! What this is and is not:
//! - It moves the profile's own data within one authorized, encrypted workspace, at the user's request. It is not a
//!   way around any website's security: the plaintext blob is treated as opaque and is re-encrypted byte-for-byte,
//!   so Chromium's own per-cookie domain binding still has to match on the destination or the browser drops the
//!   cookie.
//! - It does not touch the browser sandbox, the app's authentication, tenant isolation, or the snapshot encryption.
//!   The carried values live only (a) briefly in memory while being re-keyed and (b) inside the AES-256-GCM sealed
//!   snapshot. Nothing is ever written to disk in the clear.
//! - It is best-effort and fails safe: any cookie whose at-rest scheme this build cannot carry (for example Windows
//!   app-bound `v20` values) is simply left behind for a fresh sign-in; it is never dropped or downgraded.
//!
//! The honesty guarantee lives in `pb_sync::portability`: a restore is labelled `supported` (stay signed in) only
//! for OS pairs the runtime pipeline has MEASURED, on real runners, to actually stay signed in. This module makes
//! that true; the pipeline fails the build on any `supported` label whose session did not in fact survive.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

const CARRY_FORMAT: &str = "project-browser-cookie-carry";
const CARRY_VERSION: u32 = 1;

/// Chromium cookie encryption is AES-128-CBC with this fixed IV on macOS and Linux.
const CBC_IV: [u8; 16] = [b' '; 16];
const PBKDF2_SALT: &[u8] = b"saltysalt";

type Enc = cbc::Encryptor<aes::Aes128>;
type Dec = cbc::Decryptor<aes::Aes128>;

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[derive(Serialize, Deserialize)]
struct CarryDoc {
    format: String,
    version: u32,
    databases: Vec<PortableDb>,
}

#[derive(Serialize, Deserialize)]
struct PortableDb {
    /// Path of the cookie database relative to the profile's `user-data` directory (forward slashes), so the
    /// destination writes back into the same file after extraction.
    rel: String,
    cookies: Vec<PortableCookie>,
}

#[derive(Serialize, Deserialize)]
struct PortableCookie {
    rowid: i64,
    /// Base64 of the opaque decrypted cookie value (whatever Chromium stored, including its own domain-bound
    /// prefix). Only ever present inside the encrypted snapshot.
    v: String,
}

/// What a restore did, for a non-secret audit line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RestoreReport {
    pub databases: usize,
    pub restored: usize,
    pub skipped: usize,
}

// --------------------------------------------------------------------------------------------- cookie databases

/// The cookie databases inside a profile's `user-data` directory. Modern Chromium keeps them at
/// `<profile>/Network/Cookies`; older trees used `<profile>/Cookies`. Each immediate subdirectory that has a
/// `Preferences` file is a browser profile (`Default`, `Profile 1`, …).
fn cookie_dbs(user_data: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(user_data) else {
        return out;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        if !dir.join("Preferences").is_file() {
            continue;
        }
        for candidate in [dir.join("Network").join("Cookies"), dir.join("Cookies")] {
            if candidate.is_file() {
                out.push(candidate);
            }
        }
    }
    out.sort();
    out
}

// ------------------------------------------------------------------------------------------------------- collect

/// Decrypt the profile's own stored sessions into a portable, snapshot-encrypted member (see the module docs).
/// Returns `None` when there is nothing to carry or the source cookie key is unavailable. The returned bytes hold
/// cookie values in the clear and MUST only be placed inside the end-to-end-encrypted snapshot.
pub fn collect_portable(user_data: &Path) -> Option<Zeroizing<Vec<u8>>> {
    let dbs = cookie_dbs(user_data);
    if dbs.is_empty() {
        return None;
    }
    let key = source_key(user_data)?;
    let mut databases = Vec::new();
    for db in &dbs {
        let Ok(rel) = db.strip_prefix(user_data) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let mut cookies = Vec::new();
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) && let Ok(mut stmt) = conn.prepare("SELECT rowid, encrypted_value FROM cookies")
            && let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        {
            for (rowid, enc) in rows.flatten() {
                if let Some(pt) = key.decrypt(&enc) {
                    cookies.push(PortableCookie {
                        rowid,
                        v: b64().encode(&pt),
                    });
                }
            }
        }
        if !cookies.is_empty() {
            databases.push(PortableDb { rel, cookies });
        }
    }
    if databases.is_empty() {
        return None;
    }
    let doc = CarryDoc {
        format: CARRY_FORMAT.to_owned(),
        version: CARRY_VERSION,
        databases,
    };
    serde_json::to_vec(&doc).ok().map(Zeroizing::new)
}

// ------------------------------------------------------------------------------------------------------- restore

/// Re-encrypt carried sessions under this computer's cookie key and write them into the just-restored, closed
/// profile at `user_data` (see the module docs). `portable` is the decrypted `cookies.json` snapshot member, held
/// only in memory. Best-effort and fail-safe: returns a non-secret [`RestoreReport`]; a cookie it cannot carry is
/// left for a fresh sign-in.
pub fn restore_portable(user_data: &Path, portable: &[u8]) -> RestoreReport {
    let mut report = RestoreReport::default();
    let Ok(doc) = serde_json::from_slice::<CarryDoc>(portable) else {
        return report;
    };
    if doc.format != CARRY_FORMAT || doc.version != CARRY_VERSION {
        return report;
    }
    let total: usize = doc.databases.iter().map(|d| d.cookies.len()).sum();
    let Some(key) = destination_key(user_data) else {
        report.skipped = total;
        return report;
    };
    for db in &doc.databases {
        // The relative path is validated: normal components only, no traversal or roots.
        let Some(path) = safe_join(user_data, &db.rel) else {
            report.skipped += db.cookies.len();
            continue;
        };
        if !path.is_file() {
            report.skipped += db.cookies.len();
            continue;
        }
        match write_back(&path, &db.cookies, &key) {
            Ok(n) => {
                report.databases += 1;
                report.restored += n;
                report.skipped += db.cookies.len() - n;
            }
            Err(_) => report.skipped += db.cookies.len(),
        }
    }
    report
}

fn write_back(db: &Path, cookies: &[PortableCookie], key: &CookieKey) -> rusqlite::Result<usize> {
    let mut conn = rusqlite::Connection::open(db)?;
    let tx = conn.transaction()?;
    let mut done = 0usize;
    {
        let mut stmt = tx.prepare("UPDATE cookies SET encrypted_value = ?1 WHERE rowid = ?2")?;
        for c in cookies {
            let Ok(pt) = b64().decode(c.v.as_bytes()) else {
                continue;
            };
            let pt = Zeroizing::new(pt);
            let Some(blob) = key.encrypt(&pt) else {
                continue;
            };
            if stmt.execute(rusqlite::params![blob, c.rowid])? == 1 {
                done += 1;
            }
        }
    }
    tx.commit()?;
    Ok(done)
}

/// Joins a snapshot-supplied relative path onto `base`, allowing only plain path components (no `..`, no absolute
/// path, no root or prefix). The snapshot is already authenticated, but cookie paths still get the same care the
/// archive extractor gives every member.
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    let mut parts = 0;
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', '\0', ':']) {
            return None;
        }
        out.push(part);
        parts += 1;
    }
    (parts > 0).then_some(out)
}

// ------------------------------------------------------------------------------------------------- cookie cipher

/// A browser cookie key for this computer, able to decrypt and re-encrypt cookie values exactly as Chromium does.
enum CookieKey {
    /// macOS / Linux: AES-128-CBC with [`CBC_IV`]; `write_prefix` is the version tag this computer's store writes.
    Cbc {
        key: Zeroizing<[u8; 16]>,
        write_prefix: &'static [u8],
    },
    /// Windows: AES-256-GCM with a per-value random nonce; values are tagged `v10`.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Gcm { key: Zeroizing<[u8; 32]> },
}

impl CookieKey {
    /// Decrypts a Chromium `encrypted_value` to its opaque plaintext, or `None` when the value uses a scheme this
    /// build cannot carry (empty/legacy values, Windows app-bound `v20`, …).
    fn decrypt(&self, blob: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        if blob.len() < 3 {
            return None;
        }
        let (prefix, body) = blob.split_at(3);
        match self {
            CookieKey::Cbc { key, .. } => {
                if prefix != b"v10" && prefix != b"v11" {
                    return None;
                }
                let pt = Dec::new((&**key).into(), (&CBC_IV).into())
                    .decrypt_padded_vec::<Pkcs7>(body)
                    .ok()?;
                Some(Zeroizing::new(pt))
            }
            CookieKey::Gcm { key } => {
                if prefix != b"v10" {
                    return None; // v11/v20 app-bound keys are not available to a standalone build
                }
                if body.len() < 12 + 16 {
                    return None;
                }
                let (nonce, ct) = body.split_at(12);
                let nonce = Nonce::try_from(nonce).ok()?;
                let pt = Aes256Gcm::new((&**key).into()).decrypt(&nonce, ct).ok()?;
                Some(Zeroizing::new(pt))
            }
        }
    }

    /// Re-encrypts an opaque plaintext into a Chromium `encrypted_value` this computer's browser will accept.
    fn encrypt(&self, pt: &[u8]) -> Option<Vec<u8>> {
        match self {
            CookieKey::Cbc { key, write_prefix } => {
                let ct =
                    Enc::new((&**key).into(), (&CBC_IV).into()).encrypt_padded_vec::<Pkcs7>(pt);
                let mut out = write_prefix.to_vec();
                out.extend_from_slice(&ct);
                Some(out)
            }
            CookieKey::Gcm { key } => {
                let mut nonce = [0u8; 12];
                getrandom::fill(&mut nonce).ok()?;
                let n = Nonce::try_from(&nonce[..]).ok()?;
                let sealed = Aes256Gcm::new((&**key).into()).encrypt(&n, pt).ok()?;
                let mut out = b"v10".to_vec();
                out.extend_from_slice(&nonce);
                out.extend_from_slice(&sealed);
                Some(out)
            }
        }
    }
}

/// Derives a 16-byte AES-128 key from a Safe Storage password exactly as Chromium does (PBKDF2-HMAC-SHA1,
/// salt `saltysalt`). macOS uses 1003 iterations; Linux uses 1.
fn cbc_key_from_password(password: &[u8], iterations: u32) -> Zeroizing<[u8; 16]> {
    let mut key = Zeroizing::new([0u8; 16]);
    // Infallible for a 16-byte output; HMAC accepts any key length.
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, PBKDF2_SALT, iterations, &mut key[..]);
    key
}

// ------------------------------------------------------------------------------------------------------- Linux

#[cfg(target_os = "linux")]
fn linux_basic_key() -> CookieKey {
    // The "basic" password store (headless/CI and desktops without a Secret Service) uses the well-known password
    // "peanuts" with one PBKDF2 iteration. Values are tagged `v10`. A Secret-Service-backed `v11` key is not
    // carried: Linux is a development/CI platform only and is never promised across devices (ADR-0028).
    CookieKey::Cbc {
        key: cbc_key_from_password(b"peanuts", 1),
        write_prefix: b"v10",
    }
}

#[cfg(target_os = "linux")]
fn source_key(_user_data: &Path) -> Option<CookieKey> {
    Some(linux_basic_key())
}

#[cfg(target_os = "linux")]
fn destination_key(_user_data: &Path) -> Option<CookieKey> {
    Some(linux_basic_key())
}

// ------------------------------------------------------------------------------------------------------- macOS

/// Candidate Keychain (service, account) pairs for the browser's Safe Storage password, most specific first. An
/// explicit override lets the manager (which knows the installed browser) or a test name the exact item.
#[cfg(target_os = "macos")]
fn mac_safe_storage_candidates() -> Vec<(String, String)> {
    let mut v = Vec::new();
    if let (Ok(s), Ok(a)) = (
        std::env::var("PB_COOKIE_SAFE_STORAGE_SERVICE"),
        std::env::var("PB_COOKIE_SAFE_STORAGE_ACCOUNT"),
    ) {
        v.push((s, a));
    }
    for (s, a) in [
        (
            "Google Chrome for Testing Safe Storage",
            "Google Chrome for Testing",
        ),
        ("Chromium Safe Storage", "Chromium"),
        ("Chrome Safe Storage", "Chrome"),
    ] {
        v.push((s.to_owned(), a.to_owned()));
    }
    v
}

#[cfg(target_os = "macos")]
fn mac_cbc_from_password(password: &str) -> CookieKey {
    CookieKey::Cbc {
        key: cbc_key_from_password(password.as_bytes(), 1003),
        write_prefix: b"v10",
    }
}

#[cfg(target_os = "macos")]
fn source_key(_user_data: &Path) -> Option<CookieKey> {
    for (service, account) in mac_safe_storage_candidates() {
        if let Ok(entry) = keyring::Entry::new(&service, &account)
            && let Ok(pw) = entry.get_password()
        {
            return Some(mac_cbc_from_password(&pw));
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn destination_key(_user_data: &Path) -> Option<CookieKey> {
    // Prefer an existing Safe Storage item (one the installed browser already created); otherwise create one under
    // the browser's own name so the browser adopts it on first launch. Either way the key is held only by this
    // computer's Keychain, exactly as the browser holds its own.
    if let Some(k) = source_key(_user_data) {
        return Some(k);
    }
    let (service, account) = mac_safe_storage_candidates().into_iter().next()?;
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).ok()?;
    let password = b64().encode(raw);
    let entry = keyring::Entry::new(&service, &account).ok()?;
    entry.set_password(&password).ok()?;
    Some(mac_cbc_from_password(&password))
}

// ------------------------------------------------------------------------------------------------------- Windows

#[cfg(target_os = "windows")]
mod dpapi {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// Copies the output blob out of the OS allocation and frees it.
    unsafe fn take(out: &CRYPT_INTEGER_BLOB) -> Option<Vec<u8>> {
        if out.pbData.is_null() {
            return None;
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as *mut core::ffi::c_void) };
        Some(v)
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // CryptProtectData(pDataIn, szDataDescr, pOptionalEntropy, pvReserved, pPromptStruct, dwFlags, pDataOut)
        let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), 0, &mut out) };
        if ok == 0 {
            return None;
        }
        unsafe { take(&out) }
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // CryptUnprotectData(pDataIn, ppszDataDescr, pOptionalEntropy, pvReserved, pPromptStruct, dwFlags, pDataOut)
        let ok =
            unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut out) };
        if ok == 0 {
            return None;
        }
        unsafe { take(&out) }
    }
}

#[cfg(target_os = "windows")]
const DPAPI_PREFIX: &[u8] = b"DPAPI";

/// Reads the raw 32-byte cookie key out of a profile's `Local State`, unwrapping it with DPAPI on THIS machine.
/// Returns `None` when the file is missing, has no key, or the key was wrapped for a different machine.
#[cfg(target_os = "windows")]
fn windows_unwrap_local_state_key(user_data: &Path) -> Option<Zeroizing<[u8; 32]>> {
    let raw = std::fs::read(user_data.join("Local State")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let encoded = v.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let wrapped = b64().decode(encoded).ok()?;
    let wrapped = wrapped.strip_prefix(DPAPI_PREFIX)?;
    let key = dpapi::unprotect(wrapped)?;
    let arr: [u8; 32] = key.as_slice().try_into().ok()?;
    Some(Zeroizing::new(arr))
}

#[cfg(target_os = "windows")]
fn source_key(user_data: &Path) -> Option<CookieKey> {
    windows_unwrap_local_state_key(user_data).map(|key| CookieKey::Gcm { key })
}

#[cfg(target_os = "windows")]
fn destination_key(user_data: &Path) -> Option<CookieKey> {
    // If this computer can already unwrap the profile's Local State key, reuse it (e.g. a same-device restore).
    if let Some(key) = windows_unwrap_local_state_key(user_data) {
        return Some(CookieKey::Gcm { key });
    }
    // Otherwise the key travelled from another computer and cannot be unwrapped here. Mint a fresh key, wrap it for
    // THIS machine with DPAPI, and write it back so the browser adopts it, then re-encrypt the cookies under it.
    let mut raw = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut raw[..]).ok()?;
    let wrapped = dpapi::protect(&raw[..])?;
    let mut encoded = DPAPI_PREFIX.to_vec();
    encoded.extend_from_slice(&wrapped);
    let encoded = b64().encode(&encoded);

    let path = user_data.join("Local State");
    let mut doc: serde_json::Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    let os_crypt = doc
        .as_object_mut()?
        .entry("os_crypt")
        .or_insert_with(|| serde_json::json!({}));
    if !os_crypt.is_object() {
        *os_crypt = serde_json::json!({});
    }
    os_crypt.as_object_mut()?.insert(
        "encrypted_key".to_owned(),
        serde_json::Value::String(encoded),
    );
    // app_bound_encrypted_key, if it travelled, is for another machine and would shadow our key: drop it.
    os_crypt.as_object_mut()?.remove("app_bound_encrypted_key");
    let bytes = serde_json::to_vec(&doc).ok()?;
    std::fs::write(&path, bytes).ok()?;
    Some(CookieKey::Gcm { key: raw })
}

// -------------------------------------------------------------------------------------- other targets (no carry)

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn source_key(_user_data: &Path) -> Option<CookieKey> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn destination_key(_user_data: &Path) -> Option<CookieKey> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    fn cbc(prefix: &'static [u8]) -> CookieKey {
        CookieKey::Cbc {
            key: cbc_key_from_password(b"peanuts", 1),
            write_prefix: prefix,
        }
    }

    #[test]
    fn cbc_roundtrip_opaque_plaintext() {
        let key = cbc(b"v10");
        for value in [
            &b""[..],
            b"session=abc",
            &[0u8, 1, 2, 3, 255, 254][..],
            &[7u8; 64][..],
        ] {
            let blob = key.encrypt(value).expect("encrypt");
            assert_eq!(&blob[..3], b"v10");
            let back = key.decrypt(&blob).expect("decrypt");
            assert_eq!(&back[..], value, "re-encryption must be byte-exact");
        }
    }

    #[test]
    fn cbc_decrypts_both_v10_and_v11() {
        // The destination accepts either tag the browser might have written.
        let writer_v11 = cbc(b"v11");
        let reader = cbc(b"v10");
        let blob = writer_v11.encrypt(b"domain-bound-value").unwrap();
        assert_eq!(&blob[..3], b"v11");
        assert_eq!(&reader.decrypt(&blob).unwrap()[..], b"domain-bound-value");
    }

    #[test]
    fn gcm_roundtrip_and_prefix() {
        let key = CookieKey::Gcm {
            key: Zeroizing::new([9u8; 32]),
        };
        let value = b"\x00\x01windows cookie value";
        let blob = key.encrypt(value).expect("encrypt");
        assert_eq!(&blob[..3], b"v10");
        assert!(blob.len() >= 3 + 12 + 16);
        // A fresh nonce each time.
        let blob2 = key.encrypt(value).unwrap();
        assert_ne!(blob, blob2);
        assert_eq!(&key.decrypt(&blob).unwrap()[..], value);
        assert_eq!(&key.decrypt(&blob2).unwrap()[..], value);
    }

    #[test]
    fn unsupported_prefixes_are_skipped_not_corrupted() {
        let cbc = cbc(b"v10");
        assert!(cbc.decrypt(b"").is_none());
        assert!(cbc.decrypt(b"v2").is_none());
        let gcm = CookieKey::Gcm {
            key: Zeroizing::new([0u8; 32]),
        };
        // Windows app-bound values (v20) and short blobs are left for a fresh sign-in.
        assert!(gcm.decrypt(b"v20abc").is_none());
        assert!(gcm.decrypt(b"v10short").is_none());
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let base = Path::new("/tmp/ud");
        assert!(safe_join(base, "Default/Network/Cookies").is_some());
        assert!(safe_join(base, "../escape").is_none());
        assert!(safe_join(base, "/abs").is_none());
        assert!(safe_join(base, "a/../b").is_none());
        assert!(safe_join(base, "").is_none());
    }

    #[test]
    fn restore_rejects_foreign_or_broken_documents() {
        let dir = tempfile::tempdir().unwrap();
        // Wrong format / version / junk: nothing restored, nothing panics.
        assert_eq!(restore_portable(dir.path(), b"not json").restored, 0);
        assert_eq!(
            restore_portable(
                dir.path(),
                br#"{"format":"other","version":1,"databases":[]}"#
            )
            .restored,
            0
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_collect_restore_roundtrip_through_sqlite() {
        // A realistic Cookies database: collect decrypts with the source key, restore re-encrypts with the
        // destination key, and the row ends up carrying the same opaque plaintext.
        let dir = tempfile::tempdir().unwrap();
        let ud = dir.path();
        let profile = ud.join("Default").join("Network");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(ud.join("Default").join("Preferences"), b"{}").unwrap();
        let db = profile.join("Cookies");
        let src = linux_basic_key();
        let secret = b"auth=super-secret-session-token";
        let enc = src.encrypt(secret).unwrap();
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE cookies(host_key TEXT NOT NULL, name TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cookies(host_key,name,encrypted_value,path) VALUES ('example.test','auth',?1,'/')",
                rusqlite::params![enc],
            )
            .unwrap();
        }
        let carried = collect_portable(ud).expect("something to carry");
        // Simulate another device by clobbering the stored value, then restoring.
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute("UPDATE cookies SET encrypted_value = X'00'", [])
                .unwrap();
        }
        let report = restore_portable(ud, &carried);
        assert_eq!(report.restored, 1, "{report:?}");
        let conn = rusqlite::Connection::open(&db).unwrap();
        let blob: Vec<u8> = conn
            .query_row("SELECT encrypted_value FROM cookies", [], |r| r.get(0))
            .unwrap();
        assert_eq!(&linux_basic_key().decrypt(&blob).unwrap()[..], secret);
    }
}
