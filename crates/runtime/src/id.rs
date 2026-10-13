//! Opaque identifiers. Same grammar as `packages/contracts/src/ids.ts`:
//! `prf_` followed by 26 Crockford base32 characters (`0-9 A-H J K M N P-T V-Z`).
//!
//! A `ProfileId` is the ONLY input from which a profile's on-disk location is derived. Display labels,
//! client names and folders never reach the filesystem.

use serde::{Deserialize, Serialize};
use std::fmt;

const BODY_LEN: usize = 26;
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn valid_body(body: &str) -> bool {
    body.len() == BODY_LEN && body.bytes().all(|b| CROCKFORD.contains(&b))
}

/// 48-bit milliseconds + 80 random bits, Crockford base32 (same layout as the server's ids).
fn generate_body() -> Result<String, getrandom::Error> {
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
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Random hex string for opaque local secrets/nonces (e.g. installation ids). Not an entity id.
pub fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

macro_rules! opaque_id {
    ($(#[$meta:meta])* $name:ident, $err:ident, $prefix:literal, $what:literal) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        #[derive(Debug, PartialEq, Eq)]
        pub struct $err;

        impl fmt::Display for $err {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!("invalid ", $what, " id"))
            }
        }

        impl std::error::Error for $err {}

        impl $name {
            pub const PREFIX: &'static str = $prefix;

            pub fn parse(value: &str) -> Result<Self, $err> {
                let body = value.strip_prefix($prefix).ok_or($err)?;
                if !valid_body(body) {
                    return Err($err);
                }
                Ok(Self(value.to_owned()))
            }

            /// Generates a new id on this device. See docs/adr/0008 (item 8) for reconciliation with server ids.
            pub fn generate() -> Result<Self, getrandom::Error> {
                Ok(Self(format!("{}{}", $prefix, generate_body()?)))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = $err;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(&value)
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> Self {
                id.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

opaque_id!(
    /// Profile id: the ONLY input from which a profile's on-disk location is derived.
    ProfileId, InvalidProfileId, "prf_", "profile"
);
opaque_id!(
    /// Local workspace id (ADR-0009). A local workspace becomes an organization at first sync (milestone 06/07).
    WorkspaceId, InvalidWorkspaceId, "wsp_", "workspace"
);
opaque_id!(
    /// This device's id, generated once per installation.
    DeviceId, InvalidDeviceId, "dev_", "device"
);
opaque_id!(
    /// Local client (a customer/account group that profiles belong to; shown as a folder). Milestone 04.
    ClientId, InvalidClientId, "cli_", "client"
);
opaque_id!(
    /// Profile tag within a workspace. Milestone 04.
    TagId, InvalidTagId, "tag_", "tag"
);
opaque_id!(
    /// Reusable profile configuration template. Milestone 04.
    TemplateId, InvalidTemplateId, "tpl_", "template"
);
opaque_id!(
    /// Configuration import job. Milestone 04.
    ImportJobId, InvalidImportJobId, "imp_", "import job"
);
opaque_id!(
    /// Saved profile-table filter. Milestone 04.
    FilterId, InvalidFilterId, "flt_", "saved filter"
);

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
    fn prefixes_are_not_interchangeable() {
        let w = WorkspaceId::generate().unwrap_or_else(|_| panic!("rng"));
        assert!(w.as_str().starts_with("wsp_"));
        assert!(ProfileId::parse(w.as_str()).is_err());
        assert!(DeviceId::parse(w.as_str()).is_err());
        assert_eq!(random_hex(16).map(|h| h.len()), Ok(32));
    }

    #[test]
    fn deserialization_enforces_the_grammar() {
        let ok: Result<ProfileId, _> = serde_json::from_str("\"prf_01J9ZSEED0A010000000000000\"");
        assert!(ok.is_ok());
        let bad: Result<ProfileId, _> = serde_json::from_str("\"../../etc\"");
        assert!(bad.is_err());
    }
}
