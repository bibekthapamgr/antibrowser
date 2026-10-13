//! Milestone 04: clients, tags, query, bulk actions with undo, trash, templates, saved filters, import jobs.

use super::*;
use crate::bulk::{BulkOp, ItemOutcome};
use crate::catalog::TemplateConfig;
use crate::query::{ClientFilter, ProfileFilter, Sort, SortKey, View};
use serde_json::json;

fn id(n: u32) -> ProfileId {
    ProfileId::parse(&format!("prf_01J9ZSEED0{n:016}")).unwrap_or_else(|_| panic!("id"))
}

fn open() -> Result<(tempfile::TempDir, LocalStore, Workspace), StoreError> {
    let dir = tempfile::tempdir()?;
    let store = LocalStore::open(&dir.path().join("local.db"))?;
    let ws = store.create_workspace("Agency")?;
    Ok((dir, store, ws))
}

fn filter(ws: &Workspace) -> ProfileFilter {
    ProfileFilter {
        workspace: Some(ws.id.clone()),
        ..Default::default()
    }
}

fn names(page: &query::QueryPage) -> Vec<&str> {
    page.rows.iter().map(|p| p.name.as_str()).collect()
}

#[test]
fn upgrade_from_v3_turns_client_labels_into_clients_and_folders_into_tags() -> Result<(), StoreError>
{
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("local.db");
    {
        let mut conn = Connection::open(&path)?;
        let tx = conn.transaction()?;
        for (_, _, step) in &migrations::MIGRATIONS[..3] {
            step(&tx)?;
        }
        tx.execute(
            "insert into workspaces (id, name) values ('wsp_01J9ZSEED0A010000000000000', 'W')",
            [],
        )?;
        for (n, name, client, colour, folder) in [
            (1, "Shop", Some("Acme"), Some("#112233"), Some("Ads team")),
            (2, "Mail", Some("acme "), None, None),
            (3, "École", Some("Ünïcode Client"), None, Some("Ads team")),
            (4, "Plain", None, None, None),
        ] {
            tx.execute(
                "insert into profiles (id, workspace_id, name, search_text, client_label, client_colour, folder_label,
                                       data_dir_ref)
                 values (?1, 'wsp_01J9ZSEED0A010000000000000', ?2, lower(?2), ?3, ?4, ?5, ?1)",
                params![id(n).as_str(), name, client, colour, folder],
            )?;
        }
        tx.execute(
            "insert into audit_log (profile_id, action, outcome) values (?1, 'start', 'ok')",
            [id(1).as_str()],
        )?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
    }
    let store = LocalStore::open(&path)?;
    assert_eq!(store.schema_version()?, SCHEMA_VERSION);
    assert!(dir.path().join("local.db.v3.bak").is_file());
    let ws =
        WorkspaceId::parse("wsp_01J9ZSEED0A010000000000000").map_err(|_| StoreError::Corrupt)?;
    let clients = store.list_clients(&ws, true)?;
    assert_eq!(
        clients.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["Acme", "Ünïcode Client"],
        "labels differing only by case/space become one client"
    );
    let shop = store.get_profile(&id(1))?.ok_or(StoreError::NotFound)?;
    let mail = store.get_profile(&id(2))?.ok_or(StoreError::NotFound)?;
    assert_eq!(shop.client_id, mail.client_id);
    assert_eq!(shop.client_colour.as_deref(), Some("#112233"));
    assert_eq!(
        shop.tags
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["Ads team"]
    );
    let ecole = store.get_profile(&id(3))?.ok_or(StoreError::NotFound)?;
    assert_eq!(ecole.tags.len(), 1, "same folder label, same tag");
    // Search is Unicode-aware after the upgrade (SQLite's lower() was ASCII-only).
    let found = store.search_profiles(Some(&ws), Some("ÉCOLE"), 10)?;
    assert_eq!(found.len(), 1);
    assert_eq!(
        store.list_audit(Some(&id(1)), 10)?.len(),
        1,
        "audit log kept"
    );
    store.audit(Some(&id(1)), "trash", "ok", None, None)?;
    Ok(())
}

#[test]
fn names_need_not_be_unique_but_ids_and_client_names_are() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    store.insert_profile(NewProfile::basic(id(1), Some(ws.id.clone()), "Same", None))?;
    store.insert_profile(NewProfile::basic(id(2), Some(ws.id.clone()), "Same", None))?;
    assert!(
        store
            .insert_profile(NewProfile::basic(id(1), Some(ws.id.clone()), "Other", None))
            .is_err()
    );
    store.create_client(&ws.id, "North", Some("#123456"))?;
    assert!(matches!(
        store.create_client(&ws.id, "  NORTH ", None),
        Err(StoreError::Duplicate)
    ));
    // Another workspace may reuse the name.
    let other = store.create_workspace("Other")?;
    store.create_client(&other.id, "North", None)?;
    assert_eq!(
        store.ensure_client(&ws.id, "north")?,
        store
            .find_client(&ws.id, "North")?
            .ok_or(StoreError::NotFound)?
    );
    Ok(())
}

#[test]
fn query_filters_sorts_and_pages() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    let north = store.ensure_client(&ws.id, "North")?;
    let south = store.ensure_client(&ws.id, "South")?;
    let vip = store.ensure_tag(&ws.id, "VIP")?;
    let ads = store.ensure_tag(&ws.id, "Ads")?;
    let rows = vec![
        NewProfile {
            tags: vec![vip.id.clone(), ads.id.clone()],
            favourite: true,
            ..NewProfile::basic(
                id(1),
                Some(ws.id.clone()),
                "Shop admin",
                Some(north.clone()),
            )
        },
        NewProfile {
            tags: vec![ads.id.clone()],
            ..NewProfile::basic(
                id(2),
                Some(ws.id.clone()),
                "école mail",
                Some(south.clone()),
            )
        },
        NewProfile::basic(id(3), Some(ws.id.clone()), "Zeta", None),
        NewProfile::basic(
            id(4),
            Some(ws.id.clone()),
            "archived one",
            Some(north.clone()),
        ),
        NewProfile::basic(id(5), Some(ws.id.clone()), "trashed one", None),
    ];
    store.insert_profiles(&rows)?;
    let none = &|| false;
    store.bulk_apply(&ws.id, &[id(4)], &BulkOp::Archive, none)?;
    store.bulk_apply(
        &ws.id,
        &[id(5)],
        &BulkOp::Trash { retention_days: 30 },
        none,
    )?;

    let all = store.query_profiles(&filter(&ws), Sort::default(), 0, 100)?;
    assert_eq!(
        names(&all),
        ["école mail", "Shop admin", "Zeta"],
        "case-insensitive name order; archived/trash hidden"
    );
    assert_eq!(all.total, 3);

    let by_text = |t: &str| -> Result<Vec<String>, StoreError> {
        let f = ProfileFilter {
            text: Some(t.into()),
            ..filter(&ws)
        };
        Ok(store
            .query_profiles(&f, Sort::default(), 0, 100)?
            .rows
            .into_iter()
            .map(|p| p.name)
            .collect())
    };
    assert_eq!(by_text("ÉCOLE")?, ["école mail"], "Unicode case folding");
    assert_eq!(by_text("ecole")?, ["école mail"], "accent-insensitive");
    assert_eq!(by_text("north")?, ["Shop admin"], "client name");
    assert_eq!(by_text("vip")?, ["Shop admin"], "tag name");
    assert_eq!(
        by_text("%")?,
        Vec::<String>::new(),
        "LIKE wildcards are literal"
    );
    assert_eq!(by_text(id(3).as_str())?, ["Zeta"], "exact id");

    let f = ProfileFilter {
        client: ClientFilter::Ids(vec![north.clone()]),
        ..filter(&ws)
    };
    assert_eq!(
        names(&store.query_profiles(&f, Sort::default(), 0, 10)?),
        ["Shop admin"]
    );
    let f = ProfileFilter {
        client: ClientFilter::None,
        ..filter(&ws)
    };
    assert_eq!(
        names(&store.query_profiles(&f, Sort::default(), 0, 10)?),
        ["Zeta"]
    );
    let f = ProfileFilter {
        tags: vec![ads.id.clone(), vip.id.clone()],
        ..filter(&ws)
    };
    assert_eq!(
        names(&store.query_profiles(&f, Sort::default(), 0, 10)?),
        ["Shop admin"],
        "all tags must match"
    );
    let f = ProfileFilter {
        favourites_only: true,
        ..filter(&ws)
    };
    assert_eq!(store.query_profiles(&f, Sort::default(), 0, 10)?.total, 1);
    let f = ProfileFilter {
        view: View::Archived,
        ..filter(&ws)
    };
    assert_eq!(
        names(&store.query_profiles(&f, Sort::default(), 0, 10)?),
        ["archived one"]
    );
    let f = ProfileFilter {
        view: View::Trash,
        ..filter(&ws)
    };
    let trash = store.query_profiles(&f, Sort::default(), 0, 10)?;
    assert_eq!(names(&trash), ["trashed one"]);
    assert!(trash.rows[0].purge_after.is_some());
    let f = ProfileFilter {
        states: vec![RunState::Running],
        ..filter(&ws)
    };
    assert_eq!(store.query_profiles(&f, Sort::default(), 0, 10)?.total, 0);

    let by_client = store.query_profiles(
        &filter(&ws),
        Sort {
            key: SortKey::Client,
            descending: false,
        },
        0,
        10,
    )?;
    assert_eq!(
        names(&by_client),
        ["Shop admin", "école mail", "Zeta"],
        "no client sorts last"
    );
    let page2 = store.query_profiles(&filter(&ws), Sort::default(), 1, 1)?;
    assert_eq!((names(&page2), page2.total), (vec!["Shop admin"], 3));
    assert_eq!(
        store.query_ids(&filter(&ws), Sort::default(), 2)?,
        [id(2), id(1)]
    );

    let counts = store.profile_counts(&ws.id)?;
    assert_eq!(
        (
            counts.active,
            counts.favourites,
            counts.archived,
            counts.trash,
            counts.without_client
        ),
        (3, 1, 1, 1, 1)
    );
    assert!(counts.per_client.contains(&(north, 1)));

    let too_long = ProfileFilter {
        text: Some("x".repeat(201)),
        ..filter(&ws)
    };
    assert!(matches!(
        store.query_profiles(&too_long, Sort::default(), 0, 10),
        Err(StoreError::Invalid(_))
    ));
    Ok(())
}

#[test]
fn bulk_actions_report_each_profile_and_can_be_undone() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    let other = store.create_workspace("Other")?;
    let north = store.ensure_client(&ws.id, "North")?;
    let south = store.ensure_client(&ws.id, "South")?;
    store.insert_profiles(&[
        NewProfile::basic(id(1), Some(ws.id.clone()), "A", Some(north.clone())),
        NewProfile::basic(id(2), Some(ws.id.clone()), "B", Some(south.clone())),
        NewProfile::basic(id(3), Some(ws.id.clone()), "C", None),
        NewProfile::basic(id(9), Some(other.id.clone()), "Elsewhere", None),
    ])?;
    let none = &|| false;
    let target = vec![id(1), id(2), id(3), id(9), id(77)];
    let op = BulkOp::Move {
        client_id: Some(north.clone()),
    };
    let results = store.bulk_apply(&ws.id, &target, &op, none)?;
    let outcomes: Vec<&str> = results
        .iter()
        .map(|r| match r.outcome {
            ItemOutcome::Changed { .. } => "changed",
            ItemOutcome::Unchanged => "unchanged",
            ItemOutcome::NotFound => "not_found",
        })
        .collect();
    assert_eq!(
        outcomes,
        ["unchanged", "changed", "changed", "not_found", "not_found"]
    );
    assert_eq!(
        store
            .get_profile(&id(9))?
            .ok_or(StoreError::NotFound)?
            .client_id,
        None,
        "other workspace untouched"
    );

    // Someone edits B after the move; undo restores C only and reports B as changed since.
    let b = store.get_profile(&id(2))?.ok_or(StoreError::NotFound)?;
    store.update_profile(
        &id(2),
        ProfileUpdate {
            notes: Some("edited"),
            ..Default::default()
        },
        b.version,
    )?;
    let (restored, skipped) = store.bulk_undo(&op, &results)?;
    assert_eq!((restored, skipped), (1, 1));
    assert_eq!(
        store
            .get_profile(&id(3))?
            .ok_or(StoreError::NotFound)?
            .client_id,
        None
    );
    assert_eq!(
        store
            .get_profile(&id(2))?
            .ok_or(StoreError::NotFound)?
            .client_id,
        Some(north.clone())
    );

    // Tags, favourite and archive round-trip through undo.
    let tag = store.ensure_tag(&ws.id, "Ads")?;
    for op in [
        BulkOp::AddTag {
            tag_id: tag.id.clone(),
        },
        BulkOp::Favourite { value: true },
        BulkOp::Archive,
    ] {
        let before: Vec<LocalProfile> = [id(1), id(3)]
            .iter()
            .filter_map(|i| store.get_profile(i).ok().flatten())
            .collect();
        let r = store.bulk_apply(&ws.id, &[id(1), id(3)], &op, none)?;
        assert!(
            r.iter()
                .all(|x| matches!(x.outcome, ItemOutcome::Changed { .. })),
            "{op:?}"
        );
        store.bulk_undo(&op, &r)?;
        for p in before {
            let now = store.get_profile(&p.id)?.ok_or(StoreError::NotFound)?;
            assert_eq!(
                (now.tags.len(), now.favourite, now.archived_at.is_some()),
                (p.tags.len(), p.favourite, p.archived_at.is_some())
            );
        }
    }

    // Cancellation stops between batches.
    let many: Vec<ProfileId> = (100..100 + bulk::BATCH as u32 * 2).map(id).collect();
    let rows: Vec<NewProfile> = many
        .iter()
        .map(|i| NewProfile::basic(i.clone(), Some(ws.id.clone()), "m", None))
        .collect();
    store.insert_profiles(&rows)?;
    let calls = std::cell::Cell::new(0);
    let cancel_after_first = || {
        calls.set(calls.get() + 1);
        calls.get() > 1
    };
    let partial = store.bulk_apply(
        &ws.id,
        &many,
        &BulkOp::Favourite { value: true },
        &cancel_after_first,
    )?;
    assert_eq!(partial.len(), bulk::BATCH);
    assert!(
        store
            .bulk_apply(
                &ws.id,
                &vec![id(1); bulk::MAX_BULK + 1],
                &BulkOp::Archive,
                none
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn trash_retention_restore_and_purge_list() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    store.insert_profiles(&[
        NewProfile::basic(id(1), Some(ws.id.clone()), "A", None),
        NewProfile::basic(id(2), Some(ws.id.clone()), "B", None),
    ])?;
    let none = &|| false;
    let op = BulkOp::Trash { retention_days: 30 };
    let r = store.bulk_apply(&ws.id, &[id(1), id(2)], &op, none)?;
    assert!(store.is_trashed(&id(1))?);
    assert_eq!(store.profile_count(Some(&ws.id))?, 0);
    assert!(store.due_for_purge(10)?.is_empty(), "retention not over");
    store.w()?.execute(
        "update trash_entries set purge_after = '2000-01-01T00:00:00.000Z' where profile_id = ?1",
        [id(1).as_str()],
    )?;
    assert_eq!(store.due_for_purge(10)?, [id(1)]);
    // Restore one, undo the trash of the other.
    store.bulk_apply(&ws.id, &[id(1)], &BulkOp::Restore, none)?;
    assert!(!store.is_trashed(&id(1))?);
    store.bulk_undo(&op, &r[1..])?;
    assert!(!store.is_trashed(&id(2))?);
    assert!(store.delete_profile_metadata(&id(2))?);
    assert!(store.get_profile(&id(2))?.is_none());
    Ok(())
}

#[test]
fn import_refs_make_inserts_idempotent() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    let row = |n: u32, r: &str| NewProfile {
        import_ref: Some(r.into()),
        ..NewProfile::basic(id(n), Some(ws.id.clone()), "Imported", None)
    };
    assert_eq!(
        store.insert_profiles(&[row(1, "abc:2"), row(2, "abc:3")])?,
        [true, true]
    );
    // A retry generates new ids but the same references: nothing is duplicated.
    assert_eq!(
        store.insert_profiles(&[row(3, "abc:2"), row(4, "abc:4")])?,
        [false, true]
    );
    assert_eq!(store.profile_count(Some(&ws.id))?, 3);
    assert_eq!(
        store.existing_import_refs(&["abc:2".into(), "zzz:1".into()])?,
        ["abc:2"]
    );
    assert_eq!(store.profile_keys(&ws.id)?.len(), 3);
    Ok(())
}

#[test]
fn templates_saved_filters_tags_and_import_jobs() -> Result<(), StoreError> {
    let (_d, store, ws) = open()?;
    let config: TemplateConfig = serde_json::from_value(json!({
        "start_urls": ["https://shop.example/"], "camera": "block", "tags": ["Ads"]
    }))
    .map_err(|_| StoreError::Corrupt)?;
    let t = store.save_template(&ws.id, "Shop setup", &config)?;
    assert_eq!(t.config.microphone, PermissionDefault::Ask);
    assert_eq!(store.list_templates(&ws.id)?.len(), 1);
    assert!(
        serde_json::from_value::<TemplateConfig>(json!({ "cookies": "x" })).is_err(),
        "no unknown fields"
    );
    store.delete_template(&t.id)?;
    assert!(store.list_templates(&ws.id)?.is_empty());

    let f = store.save_filter(&ws.id, "Running VIP", &json!({ "states": ["running"] }))?;
    assert_eq!(
        store.list_saved_filters(&ws.id)?[0].filter["states"][0],
        "running"
    );
    store.delete_saved_filter(&f.id)?;

    let a = store.ensure_tag(&ws.id, "Ads")?;
    assert_eq!(store.ensure_tag(&ws.id, "ADS")?.id, a.id);
    store.rename_tag(&a.id, "Paid ads")?;
    assert_eq!(store.list_tags(&ws.id)?[0].name, "Paid ads");
    store.delete_tag(&a.id)?;

    let job = store.create_import_job(
        &ws.id,
        "clients.csv",
        &"a".repeat(64),
        "csv",
        &json!({ "duplicates": "skip" }),
        10,
    )?;
    assert!(
        store.list_import_jobs(&ws.id)?.is_empty(),
        "previews are not history"
    );
    store.start_import_job(&job.id)?;
    assert!(
        store.start_import_job(&job.id).is_err(),
        "cannot start twice"
    );
    store.import_progress(&job.id, 4, 1, 0)?;
    assert_eq!(store.mark_interrupted_imports()?, 1);
    store.start_import_job(&job.id)?;
    store.finish_import_job(
        &job.id,
        "completed_with_errors",
        (9, 1, 0),
        &json!([{ "row": 3 }]),
    )?;
    let jobs = store.list_import_jobs(&ws.id)?;
    assert_eq!(
        (jobs[0].status.as_str(), jobs[0].succeeded, jobs[0].failed),
        ("completed_with_errors", 9, 1)
    );
    Ok(())
}
