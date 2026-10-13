//! Measures sealing and opening a closed profile directory (milestone 07 backup/restore report).
//!
//! Usage: `cargo run --release -p pb-seal --example measure -- <user-data dir> <work dir>`
//!
//! Seals the directory with a fresh random key into `<work dir>/measure.pbseal`, opens it into
//! `<work dir>/opened/`, prints sizes and times, and removes both. Nothing is uploaded.
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use std::{env, fs, process};

use pb_seal::{Binding, Kind, Limits, Member, SealKey};

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let (Some(src), Some(work)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: measure <user-data dir> <work dir>");
        process::exit(2);
    };
    if let Err(e) = run(Path::new(src), Path::new(work)) {
        eprintln!("measure failed: {e}");
        process::exit(1);
    }
}

fn run(src: &Path, work: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(work)?;
    let sealed = work.join("measure.pbseal");
    let opened = work.join("opened");
    let _ = fs::remove_file(&sealed);
    let _ = fs::remove_dir_all(&opened);
    fs::create_dir(&opened)?;

    let key = SealKey::generate()?;
    let binding = Binding {
        kind: Kind::OrgSnapshot,
        org_id: Some("org_measure".into()),
        profile_id: "prf_measure".into(),
        object_id: "snp_measure".into(),
        key_version: "okv_measure".into(),
    };
    let members = [
        Member {
            name: "snapshot.json",
            bytes: b"{}",
        },
        Member {
            name: "settings.json",
            bytes: b"{}",
        },
    ];
    let cancel = AtomicBool::new(false);

    let started = Instant::now();
    let measured = pb_seal::archive::measure(src)?;
    let measure_time = started.elapsed();

    let started = Instant::now();
    let outcome =
        pb_seal::seal_profile(src, &members, &key, &binding, &sealed, &cancel, &mut |_| {})?;
    let seal_time = started.elapsed();

    let started = Instant::now();
    let (digest, _) = pb_seal::digest_file(&sealed)?;
    let digest_time = started.elapsed();
    assert_eq!(digest, outcome.digest);

    let started = Instant::now();
    let unpacked = pb_seal::open_profile(
        &sealed,
        &key,
        &binding,
        &opened,
        &Limits::default(),
        &cancel,
        &mut |_| {},
    )?;
    let open_time = started.elapsed();

    let bytes = outcome.stats.bytes;
    println!("files            {}", outcome.stats.files);
    println!(
        "profile (kept)   {:.1} MiB (measured beforehand: {:.1} MiB, {:.2} s)",
        mib(bytes),
        mib(measured),
        measure_time.as_secs_f64()
    );
    println!(
        "sealed           {:.1} MiB ({:.0}% of the kept data)",
        mib(outcome.sealed_bytes),
        100.0 * outcome.sealed_bytes as f64 / bytes.max(1) as f64
    );
    println!(
        "seal             {:.2} s ({:.0} MiB/s of profile data)",
        seal_time.as_secs_f64(),
        mib(bytes) / seal_time.as_secs_f64()
    );
    println!(
        "SHA-256 check    {:.2} s ({:.0} MiB/s of sealed data)",
        digest_time.as_secs_f64(),
        mib(outcome.sealed_bytes) / digest_time.as_secs_f64()
    );
    println!(
        "open             {:.2} s ({:.0} MiB/s of profile data, {} files)",
        open_time.as_secs_f64(),
        mib(bytes) / open_time.as_secs_f64(),
        unpacked.files
    );
    fs::remove_file(&sealed)?;
    fs::remove_dir_all(&opened)?;
    Ok(())
}
