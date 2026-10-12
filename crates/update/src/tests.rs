use super::*;
use ed25519_dalek::{Signer, SigningKey};

const SHA: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

fn manifest_json(url: &str, version: &str) -> String {
    format!(
        r#"{{"schema":2,"channel":"internal-alpha","created_at":"2026-10-12T00:00:00Z",
"distribution":{{"id":"chrome-for-testing","name":"Chrome for Testing","license":"internal only","customer_distribution":false,"source":"https://googlechromelabs.github.io/chrome-for-testing/"}},
"runtime":{{"version":"{version}","revision":"1","artifacts":[{{"platform":"windows-x64","url":"{url}","sha256":"{SHA}","size_bytes":5,"format":"zip","executable":"chrome-win64/chrome.exe"}}]}}}}"#
    )
}

const GOOD_URL: &str =
    "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/win64/chrome-win64.zip";

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn trusted(k: &SigningKey) -> TrustedKeys {
    TrustedKeys::parse(&format!(
        r#"{{"keys":[{{"key_id":"test-1","public_key":"{}","created":"2026-10-12"}}]}}"#,
        hex::encode(k.verifying_key().to_bytes())
    ))
    .unwrap_or_else(|e| panic!("{e}"))
}

fn sign(k: &SigningKey, bytes: &[u8], key_id: &str) -> Vec<u8> {
    format!(
        r#"{{"schema":1,"key_id":"{key_id}","algorithm":"ed25519","signature":"{}"}}"#,
        hex::encode(k.sign(bytes).to_bytes())
    )
    .into_bytes()
}

#[test]
fn verifies_a_signed_manifest() -> Result<(), UpdateError> {
    let k = key();
    let m = manifest_json(GOOD_URL, "155.0.8059.39");
    let parsed = verify_manifest(
        m.as_bytes(),
        &sign(&k, m.as_bytes(), "test-1"),
        &trusted(&k),
    )?;
    assert_eq!(parsed.runtime.version, "155.0.8059.39");
    assert!(parsed.artifact_for("windows-x64").is_some());
    assert!(!parsed.distribution.customer_distribution);
    Ok(())
}

#[test]
fn rejects_tampering_unknown_keys_and_bad_signatures() {
    let k = key();
    let m = manifest_json(GOOD_URL, "155.0.8059.39");
    let sig = sign(&k, m.as_bytes(), "test-1");
    let tampered = m.replace("155.0.8059.39", "155.0.8059.40");
    assert!(matches!(
        verify_manifest(tampered.as_bytes(), &sig, &trusted(&k)),
        Err(UpdateError::BadSignature)
    ));
    let other = SigningKey::from_bytes(&[9u8; 32]);
    assert!(matches!(
        verify_manifest(
            m.as_bytes(),
            &sign(&other, m.as_bytes(), "test-1"),
            &trusted(&k)
        ),
        Err(UpdateError::BadSignature)
    ));
    assert!(matches!(
        verify_manifest(
            m.as_bytes(),
            &sign(&k, m.as_bytes(), "unknown"),
            &trusted(&k)
        ),
        Err(UpdateError::BadSignature)
    ));
    assert!(matches!(
        verify_manifest(m.as_bytes(), b"not json", &trusted(&k)),
        Err(UpdateError::BadSignature)
    ));
}

#[test]
fn a_valid_signature_does_not_admit_urls_outside_the_compiled_allowlist() {
    let k = key();
    for url in [
        "https://evil.example/chrome.zip",
        "http://storage.googleapis.com/chrome-for-testing-public/x.zip",
        "https://storage.googleapis.com/other-bucket/x.zip",
        "https://storage.googleapis.com/chrome-for-testing-public/../other/x.zip",
    ] {
        let m = manifest_json(url, "155.0.8059.39");
        assert!(
            matches!(
                verify_manifest(
                    m.as_bytes(),
                    &sign(&k, m.as_bytes(), "test-1"),
                    &trusted(&k)
                ),
                Err(UpdateError::Invalid(_))
            ),
            "{url}"
        );
    }
}

#[test]
fn validates_structure() {
    assert!(RuntimeManifest::parse(&manifest_json(GOOD_URL, "155.0")).is_err());
    assert!(RuntimeManifest::parse(&manifest_json(GOOD_URL, "155.0.8059.39")).is_ok());
    let abs =
        manifest_json(GOOD_URL, "155.0.8059.39").replace("chrome-win64/chrome.exe", "/bin/sh");
    assert!(RuntimeManifest::parse(&abs).is_err());
    let up = manifest_json(GOOD_URL, "155.0.8059.39").replace("chrome-win64/chrome.exe", "../sh");
    assert!(RuntimeManifest::parse(&up).is_err());
    let extra = manifest_json(GOOD_URL, "155.0.8059.39").replacen('{', r#"{"extra":1,"#, 1);
    assert!(RuntimeManifest::parse(&extra).is_err());
    assert_eq!(parse_version("155.0.8059.39"), Some([155, 0, 8059, 39]));
    assert_eq!(major("155.0.8059.39"), Some(155));
    assert!(parse_version("155.0.x.39").is_none());
}

#[test]
fn verifies_artifact_digest_and_size() -> Result<(), UpdateError> {
    let m = RuntimeManifest::parse(&manifest_json(GOOD_URL, "155.0.8059.39"))?;
    let a = m
        .artifact_for("windows-x64")
        .ok_or(UpdateError::HashMismatch)?;
    let dir = tempfile::tempdir()?;
    let good = dir.path().join("a");
    std::fs::write(&good, b"hello")?;
    verify_artifact(&good, a)?;
    std::fs::write(&good, b"hellO")?;
    assert!(matches!(
        verify_artifact(&good, a),
        Err(UpdateError::HashMismatch)
    ));
    Ok(())
}
