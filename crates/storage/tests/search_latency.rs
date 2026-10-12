//! Early measurement against the roadmap target "profile search over 10,000 metadata rows p95 <= 200 ms".
//! This is a baseline on whatever machine runs it, not an acceptance result (the reference device and
//! release build are defined in the roadmap). Run: cargo test -p pb-storage --release --test search_latency -- --ignored --nocapture

use pb_runtime::ProfileId;
use pb_storage::{LocalStore, NewProfile};
use std::time::Instant;

#[test]
#[ignore = "measurement; run explicitly in release mode"]
fn search_10k_rows_p95() {
    let tmp = tempfile::tempdir().unwrap_or_else(|_| panic!("tmp"));
    let store = LocalStore::open(&tmp.path().join("bench.db")).unwrap_or_else(|e| panic!("{e}"));
    let ids: Vec<ProfileId> = (0..10_000u32)
        .map(|n| {
            ProfileId::parse(&format!("prf_01J9ZSEED0{n:016}")).unwrap_or_else(|_| panic!("id"))
        })
        .collect();
    let names: Vec<String> = (0..10_000)
        .map(|n| format!("Profile {n} account"))
        .collect();
    let clients: Vec<String> = (0..10_000).map(|n| format!("Client {}", n % 250)).collect();
    let rows: Vec<NewProfile<'_>> = (0..10_000)
        .map(|i| NewProfile {
            id: &ids[i],
            name: &names[i],
            client_label: Some(&clients[i]),
            folder_label: None,
        })
        .collect();
    store
        .insert_profiles(&rows)
        .unwrap_or_else(|e| panic!("{e}"));

    let queries = [
        "client 17",
        "profile 99",
        "account",
        "zzz-no-match",
        "",
        "client 2",
    ];
    let mut samples = Vec::new();
    for i in 0..300 {
        let q = queries[i % queries.len()];
        let start = Instant::now();
        let found = store
            .search_profiles(Some(q), 100)
            .unwrap_or_else(|e| panic!("{e}"));
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert!(found.len() <= 100);
    }
    samples.sort_by(|a, b| a.total_cmp(b));
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95) / 100];
    println!(
        "local search over 10,000 rows: p50 {p50:.2} ms, p95 {p95:.2} ms (target p95 <= 200 ms)"
    );
    assert!(p95 <= 200.0, "p95 {p95:.2} ms exceeds the 200 ms target");
}
