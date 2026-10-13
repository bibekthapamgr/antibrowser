//! Roadmap target "profile search over 10,000 metadata rows p95 <= 200 ms" (milestone 04 gate), measured through the
//! profile table query (text search over name, client and tags, filters, sort, one page plus the total).
//! This is a baseline on whatever machine runs it, not the reference-device result. Release numbers:
//! cargo test -p pb-storage --release --test search_latency -- --nocapture

use pb_runtime::{ProfileId, RunState};
use pb_storage::query::{ClientFilter, ProfileFilter, Sort, SortKey};
use pb_storage::{LocalStore, NewProfile};
use std::time::Instant;

#[test]
fn table_query_over_10k_profiles_p95() {
    let tmp = tempfile::tempdir().unwrap_or_else(|_| panic!("tmp"));
    let store = LocalStore::open(&tmp.path().join("bench.db")).unwrap_or_else(|e| panic!("{e}"));
    let ws = store
        .create_workspace("Bench")
        .unwrap_or_else(|e| panic!("{e}"));
    let clients: Vec<_> = (0..250)
        .map(|n| {
            store
                .ensure_client(&ws.id, &format!("Client {n}"))
                .unwrap_or_else(|e| panic!("{e}"))
        })
        .collect();
    let tags: Vec<_> = ["Ads", "Shop", "Mail", "VIP", "Café"]
        .iter()
        .map(|t| {
            store
                .ensure_tag(&ws.id, t)
                .unwrap_or_else(|e| panic!("{e}"))
                .id
        })
        .collect();
    let rows: Vec<NewProfile> = (0..10_000u32)
        .map(|n| NewProfile {
            notes: "note ".repeat(40),
            tags: vec![tags[n as usize % tags.len()].clone()],
            favourite: n % 17 == 0,
            ..NewProfile::basic(
                ProfileId::parse(&format!("prf_01J9ZSEED0{n:016}"))
                    .unwrap_or_else(|_| panic!("id")),
                Some(ws.id.clone()),
                &format!("Profile {n} account"),
                Some(clients[n as usize % clients.len()].clone()),
            )
        })
        .collect();
    store
        .insert_profiles(&rows)
        .unwrap_or_else(|e| panic!("{e}"));

    let base = ProfileFilter {
        workspace: Some(ws.id.clone()),
        ..Default::default()
    };
    let filters = [
        ProfileFilter {
            text: Some("client 17".into()),
            ..base.clone()
        },
        ProfileFilter {
            text: Some("profile 99".into()),
            ..base.clone()
        },
        ProfileFilter {
            text: Some("cafe".into()),
            ..base.clone()
        },
        ProfileFilter {
            text: Some("zzz-no-match".into()),
            ..base.clone()
        },
        base.clone(),
        ProfileFilter {
            client: ClientFilter::Ids(vec![clients[3].clone()]),
            ..base.clone()
        },
        ProfileFilter {
            tags: vec![tags[3].clone()],
            favourites_only: true,
            ..base.clone()
        },
        ProfileFilter {
            states: vec![RunState::Stopped],
            text: Some("account".into()),
            ..base.clone()
        },
    ];
    let sorts = [
        Sort::default(),
        Sort {
            key: SortKey::Client,
            descending: false,
        },
        Sort {
            key: SortKey::LastUsed,
            descending: true,
        },
    ];
    let mut samples = Vec::new();
    for i in 0..240 {
        let start = Instant::now();
        let page = store
            .query_profiles(&filters[i % filters.len()], sorts[i % sorts.len()], 0, 200)
            .unwrap_or_else(|e| panic!("{e}"));
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert!(page.rows.len() <= 200);
    }
    samples.sort_by(|a, b| a.total_cmp(b));
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95) / 100];
    println!(
        "profile table query over 10,000 rows ({} build): p50 {p50:.2} ms, p95 {p95:.2} ms (target p95 <= 200 ms)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    assert!(p95 <= 200.0, "p95 {p95:.2} ms exceeds the 200 ms target");
}
