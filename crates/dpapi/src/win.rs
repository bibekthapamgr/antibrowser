//! The only `unsafe` in this crate: two Win32 calls and freeing the buffer they allocate. Each block states why it
//! is sound.
#![allow(unsafe_code)]

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
};

/// An input blob that borrows `data`. DPAPI only reads input blobs, so the `*mut` is never written through.
fn blob(data: &[u8]) -> Option<CRYPT_INTEGER_BLOB> {
    Some(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).ok()?,
        pbData: data.as_ptr().cast_mut(),
    })
}

/// Copies an output blob allocated by DPAPI and frees it.
fn take(out: &CRYPT_INTEGER_BLOB) -> Option<Vec<u8>> {
    if out.pbData.is_null() {
        return None;
    }
    // SAFETY: on success DPAPI sets `pbData` to a LocalAlloc'd buffer of exactly `cbData` bytes, which nothing else
    // references; it is read once here and then freed once with LocalFree, as the API requires.
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    // SAFETY: frees the buffer DPAPI allocated (see above); the pointer is not used afterwards.
    unsafe { LocalFree(out.pbData.cast()) };
    Some(v)
}

pub(crate) fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let input = blob(data)?;
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: `input` borrows `data`, which outlives the call; the optional arguments are null as documented
    // (no description, entropy, reserved or prompt); `out` is a valid, writable blob for the result.
    let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), 0, &mut out) };
    if ok == 0 {
        return None;
    }
    take(&out)
}

pub(crate) fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let input = blob(data)?;
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: as in `protect`; the description out-parameter is null (not requested).
    let ok = unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut out) };
    if ok == 0 {
        return None;
    }
    take(&out)
}
