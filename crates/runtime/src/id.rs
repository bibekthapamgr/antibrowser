//! Profile identifiers. Same grammar as `packages/contracts/src/ids.ts`:
//! `prf_` followed by 26 Crockford base32 characters (`0-9 A-H J K M N P-T V-Z`).
//!
//! A `ProfileId` is the ONLY input from which a profile's on-disk location is derived. Display labels,
//! client names and folders never reach the filesystem.

use serde::{Deserialize, Serialize};
use std::fmt;

const PREFIX: &str = "prf_";
const BODY_LEN: usize = 26;
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProfileId(String);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid profile id")]
pub struct InvalidProfileId;

impl ProfileId {
    pub fn parse(value: &str) -> Result<Self, InvalidProfileId> {
        let body = value.strip_prefix(PREFIX).ok_or(InvalidProfileId)?;
        if body.len() != BODY_LEN || !body.bytes().all(|b| CROCKFORD.contains(&b)) {
            return Err(InvalidProfileId);
        }
        Ok(Self(value.to_owned()))
    }

    /// Generates a new id (48-bit milliseconds + 80 random bits), for local-only profiles.
    /// See docs/adr/0002 for how local ids are reconciled with server ids on first sync.
    pub fn generate() -> Result<Self, getrandom::Error> {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut bytes = [0u8; 16];
        bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
        getrandom::fill(&mut bytes[6..])?;
        let mut value = u128::from_be_bytes(bytes);
        let mut body = [b'0'; BODY_LEN];
        for slot in body.iter_mut().rev() {
            *slot = CROCKFORD[(value & 31) as usize];
            value >>= 5;
        }
        let body = String::from_utf8_lossy(&body);
        Ok(Self(format!("{PREFIX}{body}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ProfileId {
    type Error = InvalidProfileId;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<ProfileId> for String {
    fn from(id: ProfileId) -> Self {
        id.0
    }
}

impl fmt::Display for ProfileId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_and_generated_ids() {
        assert!(ProfileId::parse("prf_01J9ZSEED0A0100000000000000").is_err()); // 27 chars
        assert!(ProfileId::parse("prf_01J9ZSEED0A010000000000000").is_ok());
        for _ in 0..1000 {
            let id = ProfileId::generate().unwrap_or_else(|_| panic!("rng"));
            assert!(ProfileId::parse(id.as_str()).is_ok(), "{id}");
        }
    }

    #[test]
    fn rejects_path_like_and_malformed_values() {
        let bad = [
            "",
            "prf_",
            "../prf_01J9ZSEED0A010000000000000",
            "prf_../../../../etc/passwd000000",
            "prf_01J9ZSEED0A01000000000000/",
            "prf_01J9ZSEED0A01000000000000\\",
            "prf_01j9zseed0a010000000000000", // lowercase
            "prf_01J9ZSEED0A0100000000000I0", // I is not Crockford
            "prf_01J9ZSEED0A01000000000000\0",
            "PRF_01J9ZSEED0A010000000000000",
            "org_01J9ZSEED0A010000000000000",
            "prf_01J9ZSEED0A01000000000000Ａ", // full-width A
            "C:\\Users\\x",
            "/tmp/x",
        ];
        for value in bad {
            assert_eq!(ProfileId::parse(value), Err(InvalidProfileId), "{value:?}");
        }
    }

    #[test]
    fn deserialization_enforces_the_grammar() {
        let ok: Result<ProfileId, _> = serde_json::from_str("\"prf_01J9ZSEED0A010000000000000\"");
        assert!(ok.is_ok());
        let bad: Result<ProfileId, _> = serde_json::from_str("\"../../etc\"");
        assert!(bad.is_err());
    }
}
