//! Sealed profile archives (milestone 07, ADR-0014): a closed browser profile is archived (tar), compressed (zstd),
//! then encrypted and authenticated in chunks (AES-256-GCM, STREAM) with a header that binds the file to its
//! organization, profile, snapshot and key version. The same format serves organization snapshots (data key from the
//! server) and local last-good backups (device key in the OS keychain).
//!
//! - [`format`]: the container, data keys, streaming encryption and decryption.
//! - [`archive`]: what goes in (explicit exclusion list, no links) and safe extraction into a fresh directory.
//!
//! [`seal_profile`] and [`open_profile`] combine them. Opening fails closed: a wrong key, a changed header, a
//! truncated or modified file, or an unsafe archive member is an error, and nothing is written outside the fresh
//! destination directory.

pub mod archive;
pub mod format;

pub use archive::{Limits, Member, PackStats, Unpacked};
pub use format::{Binding, Header, Kind, SealKey};

use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
    #[error("the file could not be authenticated (wrong key, damaged or modified)")]
    Authentication,
    #[error("the file belongs to another {0}")]
    HeaderMismatch(&'static str),
    #[error("not a sealed file of a supported version")]
    UnsupportedFormat,
    #[error("unsafe archive: {0}")]
    UnsafeArchive(&'static str),
    #[error("the archive is larger than allowed")]
    LimitExceeded,
    #[error("cancelled")]
    Cancelled,
    #[error("the destination directory is not empty")]
    DestinationNotEmpty,
    #[error("a file changed while it was being archived")]
    ChangedDuringBackup,
    #[error("a file name cannot be stored portably")]
    UnsupportedFileName,
    #[error("invalid key")]
    BadKey,
    #[error("the system random number generator failed")]
    Randomness,
}

impl SealError {
    /// Stable code for the UI and error reports (never contains paths or key material).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(e) if e.kind() == io::ErrorKind::StorageFull => "LOW_DISK_SPACE",
            Self::Io(_) => "SEAL_IO_ERROR",
            Self::Authentication => "SEAL_AUTHENTICATION_FAILED",
            Self::HeaderMismatch(_) => "SEAL_WRONG_BINDING",
            Self::UnsupportedFormat => "SEAL_UNSUPPORTED_FORMAT",
            Self::UnsafeArchive(_) => "SEAL_UNSAFE_ARCHIVE",
            Self::LimitExceeded => "SEAL_TOO_LARGE",
            Self::Cancelled => "SEAL_CANCELLED",
            Self::DestinationNotEmpty => "SEAL_DESTINATION_NOT_EMPTY",
            Self::ChangedDuringBackup => "SEAL_CHANGED_DURING_BACKUP",
            Self::UnsupportedFileName => "SEAL_UNSUPPORTED_FILE_NAME",
            Self::BadKey => "SEAL_BAD_KEY",
            Self::Randomness => "SEAL_RANDOMNESS",
        }
    }
}

/// zstd level: fast, with good ratios on browser databases.
pub const ZSTD_LEVEL: i32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealOutcome {
    /// SHA-256 (hex) of the sealed file as stored and uploaded.
    pub digest: String,
    pub sealed_bytes: u64,
    pub stats: PackStats,
}

fn flatten(e: SealError) -> SealError {
    match e {
        SealError::Io(io) => archive::unwrap_io(io),
        other => other,
    }
}

/// Seals a closed profile directory into a new file at `out` (which must not exist). On any error the partial file
/// is removed.
pub fn seal_profile(
    user_data: &Path,
    members: &[Member<'_>],
    key: &SealKey,
    binding: &Binding,
    out: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<SealOutcome, SealError> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out)?;
    let result = (|| {
        let hashing = format::Hashing::new(BufWriter::with_capacity(1 << 20, file));
        let sealer = format::SealWriter::new(hashing, key, binding)?;
        let encoder = zstd::stream::Encoder::new(sealer, ZSTD_LEVEL)?;
        let (encoder, stats) = archive::pack(user_data, members, encoder, cancel, progress)?;
        let sealer = encoder.finish()?;
        let (hashing, _compressed) = sealer.finish()?;
        let (buffered, digest, sealed_bytes) = hashing.finish();
        let file = buffered.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()?;
        Ok(SealOutcome {
            digest,
            sealed_bytes,
            stats,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(out);
    }
    result.map_err(flatten)
}

/// Opens a sealed file into `dest` (an existing, empty directory): `dest/user-data/...` plus the metadata members,
/// returned in memory. The whole file is authenticated, including its final chunk, before this returns `Ok`; on
/// error the caller discards `dest`.
pub fn open_profile(
    sealed: &Path,
    key: &SealKey,
    expect: &Binding,
    dest: &Path,
    limits: &Limits,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<Unpacked, SealError> {
    let file = fs::File::open(sealed)?;
    let (reader, _header) =
        format::SealReader::open(BufReader::with_capacity(1 << 20, file), key, expect)?;
    let run = || -> Result<Unpacked, SealError> {
        let decoder = zstd::stream::Decoder::new(reader)?;
        let (mut decoder, unpacked) = archive::unpack(decoder, dest, limits, cancel, progress)?;
        // Read to the authenticated end: the final chunk (marked last) must verify, or this fails.
        io::copy(&mut decoder, &mut io::sink())?;
        let mut rest = decoder.finish();
        io::copy(&mut rest, &mut io::sink())?;
        Ok(unpacked)
    };
    run().map_err(flatten)
}

/// The header of a sealed file (no key needed): what it claims to be.
pub fn read_file_header(path: &Path) -> Result<Header, SealError> {
    let mut f = BufReader::new(fs::File::open(path)?);
    Ok(format::read_header(&mut f)?.0)
}

/// SHA-256 (hex) and size of a file, as the server computes them over the stored object.
pub fn digest_file(path: &Path) -> io::Result<(String, u64)> {
    format::digest_reader(BufReader::with_capacity(1 << 20, fs::File::open(path)?))
}

/// Seals raw bytes (no archive). Used by tests of the container itself.
#[doc(hidden)]
pub fn seal_bytes(bytes: &[u8], key: &SealKey, binding: &Binding) -> Result<Vec<u8>, SealError> {
    let mut w = format::SealWriter::new(Vec::new(), key, binding)?;
    w.write_all(bytes)?;
    Ok(w.finish()?.0)
}

#[doc(hidden)]
pub fn open_bytes(sealed: &[u8], key: &SealKey, expect: &Binding) -> Result<Vec<u8>, SealError> {
    let (mut r, _) = format::SealReader::open(sealed, key, expect)?;
    let mut out = Vec::new();
    r.read_to_end(&mut out).map_err(archive::unwrap_io)?;
    Ok(out)
}

#[cfg(test)]
mod tests;
