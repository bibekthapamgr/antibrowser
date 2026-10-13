//! Profile table queries (milestone 04): filtering, sorting and paging over up to [`crate::MAX_LIST`] profiles per
//! workspace. Everything is bound as SQL parameters; text search uses Unicode-folded keys with escaped `LIKE`.

use crate::migrations::name_key;
use crate::{LocalProfile, LocalStore, SELECT_PROFILE, StoreError, escape_like, row_to_profile};
use pb_runtime::{ClientId, ProfileId, ProxyId, RunState, TagId, TemplateId, WorkspaceId};
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

/// Which part of the workspace a query looks at.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum View {
    /// Not archived and not in the trash.
    #[default]
    Active,
    Archived,
    Trash,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "ids")]
pub enum ClientFilter {
    #[default]
    Any,
    /// Profiles without a client.
    None,
    /// Profiles of any of these clients.
    Ids(Vec<ClientId>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProfileFilter {
    #[serde(skip)]
    pub workspace: Option<WorkspaceId>,
    pub text: Option<String>,
    pub view: View,
    pub client: ClientFilter,
    /// The profile must carry every one of these tags.
    pub tags: Vec<TagId>,
    /// Any of these run states (empty: all).
    pub states: Vec<RunState>,
    pub favourites_only: bool,
    pub template: Option<TemplateId>,
    /// Profiles routed through this proxy (milestone 05).
    pub proxy: Option<ProxyId>,
}

impl ProfileFilter {
    /// Limits that keep a filter cheap: at most 50 clients, 20 tags, 200 characters of text.
    pub fn validate(&self) -> Result<(), StoreError> {
        if self
            .text
            .as_deref()
            .is_some_and(|t| t.chars().count() > 200)
        {
            return Err(StoreError::Invalid("search text is too long"));
        }
        if matches!(&self.client, ClientFilter::Ids(ids) if ids.is_empty() || ids.len() > 50) {
            return Err(StoreError::Invalid("choose between 1 and 50 clients"));
        }
        if self.tags.len() > 20 {
            return Err(StoreError::Invalid("at most 20 tags"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortKey {
    #[default]
    Name,
    Client,
    LastUsed,
    Created,
    State,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sort {
    pub key: SortKey,
    pub descending: bool,
}

#[derive(Debug, Serialize)]
pub struct QueryPage {
    pub rows: Vec<LocalProfile>,
    /// Profiles matching the filter (all pages).
    pub total: u64,
}

/// Counts for the sidebar (one query).
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct Counts {
    pub active: u64,
    pub favourites: u64,
    pub running: u64,
    pub archived: u64,
    pub trash: u64,
    pub without_client: u64,
    /// Active profiles per client id.
    pub per_client: Vec<(ClientId, u64)>,
}

fn ph(params: &mut Vec<Value>, v: Value) -> String {
    params.push(v);
    format!("?{}", params.len())
}

/// SQL `where` clause and its parameters for a filter.
fn where_clause(f: &ProfileFilter) -> (String, Vec<Value>) {
    let mut sql = String::from("where 1 = 1");
    let mut params: Vec<Value> = vec![];
    if let Some(ws) = &f.workspace {
        let p = ph(&mut params, Value::Text(ws.to_string()));
        sql.push_str(&format!(" and p.workspace_id = {p}"));
    }
    match f.view {
        View::Active => sql.push_str(" and p.archived_at is null and te.profile_id is null"),
        View::Archived => sql.push_str(" and p.archived_at is not null and te.profile_id is null"),
        View::Trash => sql.push_str(" and te.profile_id is not null"),
    }
    match &f.client {
        ClientFilter::Any => {}
        ClientFilter::None => sql.push_str(" and p.client_id is null"),
        ClientFilter::Ids(ids) => {
            let list: Vec<String> = ids
                .iter()
                .map(|id| ph(&mut params, Value::Text(id.to_string())))
                .collect();
            sql.push_str(&format!(" and p.client_id in ({})", list.join(", ")));
        }
    }
    for tag in &f.tags {
        let p = ph(&mut params, Value::Text(tag.to_string()));
        sql.push_str(&format!(
            " and exists (select 1 from profile_tags pt where pt.profile_id = p.id and pt.tag_id = {p})"
        ));
    }
    if !f.states.is_empty() {
        let list: Vec<String> = f
            .states
            .iter()
            .map(|s| ph(&mut params, Value::Text(s.as_str().to_owned())))
            .collect();
        sql.push_str(&format!(" and p.state in ({})", list.join(", ")));
    }
    if f.favourites_only {
        sql.push_str(" and p.favourite = 1");
    }
    if let Some(t) = &f.template {
        let p = ph(&mut params, Value::Text(t.to_string()));
        sql.push_str(&format!(" and p.template_id = {p}"));
    }
    if let Some(x) = &f.proxy {
        let p = ph(&mut params, Value::Text(x.to_string()));
        sql.push_str(&format!(" and ns.proxy_id = {p}"));
    }
    if let Some(text) = f.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let n = ph(
            &mut params,
            Value::Text(format!("%{}%", escape_like(&name_key(text)))),
        );
        let exact = ph(&mut params, Value::Text(text.to_owned()));
        sql.push_str(&format!(
            " and (p.search_text like {n} escape '\\' or c.name_key like {n} escape '\\'
                   or exists (select 1 from profile_tags pt join tags t on t.id = pt.tag_id
                              where pt.profile_id = p.id and t.name_key like {n} escape '\\')
                   or p.id = {exact})"
        ));
    }
    (sql, params)
}

fn order_by(sort: Sort) -> String {
    let dir = if sort.descending { "desc" } else { "asc" };
    let key = match sort.key {
        SortKey::Name => format!("p.search_text {dir}, p.name {dir}"),
        // Profiles without a client sort last either way.
        SortKey::Client => format!("c.name_key is null, c.name_key {dir}, p.search_text"),
        SortKey::LastUsed => {
            format!("p.last_started_at is null, p.last_started_at {dir}, p.search_text")
        }
        SortKey::Created => format!("p.created_at {dir}"),
        SortKey::State => format!(
            "case p.state when 'running' then 0 when 'starting' then 1 when 'stopping' then 2
                 when 'crashed' then 3 when 'recovering' then 4 else 5 end {dir}, p.search_text"
        ),
    };
    format!("order by {key}, p.id")
}

const FROM: &str = "from profiles p
     left join clients_local c on c.id = p.client_id
     left join trash_entries te on te.profile_id = p.id
     left join profile_network_settings ns on ns.profile_id = p.id";

impl LocalStore {
    /// One page of profiles matching `filter`, plus the total. `limit` is clamped to 1..=500 (the table loads
    /// pages as it scrolls) unless called internally with a larger bound.
    pub fn query_profiles(
        &self,
        filter: &ProfileFilter,
        sort: Sort,
        offset: u32,
        limit: u32,
    ) -> Result<QueryPage, StoreError> {
        filter.validate()?;
        let (clause, mut params) = where_clause(filter);
        let conn = self.r()?;
        let total: i64 = conn.query_row(
            &format!("select count(*) {FROM} {clause}"),
            rusqlite::params_from_iter(params.iter()),
            |r| r.get(0),
        )?;
        params.push(Value::Integer(i64::from(limit.clamp(1, crate::MAX_LIST))));
        let lim = params.len();
        params.push(Value::Integer(i64::from(offset)));
        let off = params.len();
        let sql = format!(
            "{SELECT_PROFILE} {clause} {} limit ?{lim} offset ?{off}",
            order_by(sort)
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), row_to_profile)?
            .map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(QueryPage {
            rows,
            total: total.max(0) as u64,
        })
    }

    /// Ids of every profile matching `filter`, in table order, at most `max` (used by "select all matching").
    pub fn query_ids(
        &self,
        filter: &ProfileFilter,
        sort: Sort,
        max: u32,
    ) -> Result<Vec<ProfileId>, StoreError> {
        filter.validate()?;
        let (clause, mut params) = where_clause(filter);
        params.push(Value::Integer(i64::from(max)));
        let lim = params.len();
        let conn = self.r()?;
        let mut stmt = conn.prepare(&format!(
            "select p.id {FROM} {clause} {} limit ?{lim}",
            order_by(sort)
        ))?;
        let ids = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                r.get::<_, String>(0)
            })?
            .map(|r| {
                r.map_err(StoreError::from)
                    .and_then(|s| ProfileId::parse(&s).map_err(|_| StoreError::Corrupt))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Sidebar counts for one workspace.
    pub fn profile_counts(&self, workspace: &WorkspaceId) -> Result<Counts, StoreError> {
        let conn = self.r()?;
        let (active, favourites, running, archived, trash, without_client): (
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = conn.query_row(
            &format!(
                "select
                   coalesce(sum(case when p.archived_at is null and te.profile_id is null then 1 else 0 end), 0),
                   coalesce(sum(case when p.archived_at is null and te.profile_id is null and p.favourite = 1
                                then 1 else 0 end), 0),
                   coalesce(sum(case when te.profile_id is null and p.state in ('starting', 'running', 'stopping')
                                then 1 else 0 end), 0),
                   coalesce(sum(case when p.archived_at is not null and te.profile_id is null then 1 else 0 end), 0),
                   coalesce(sum(case when te.profile_id is not null then 1 else 0 end), 0),
                   coalesce(sum(case when p.archived_at is null and te.profile_id is null and p.client_id is null
                                then 1 else 0 end), 0)
                 {FROM} where p.workspace_id = ?1"
            ),
            [workspace.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )?;
        let mut stmt = conn.prepare_cached(&format!(
            "select p.client_id, count(*) {FROM}
              where p.workspace_id = ?1 and p.client_id is not null
                and p.archived_at is null and te.profile_id is null
              group by p.client_id"
        ))?;
        let per_client = stmt
            .query_map([workspace.as_str()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .map(|r| {
                r.map_err(StoreError::from).and_then(|(id, n)| {
                    ClientId::parse(&id)
                        .map(|id| (id, n.max(0) as u64))
                        .map_err(|_| StoreError::Corrupt)
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let u = |n: i64| n.max(0) as u64;
        Ok(Counts {
            active: u(active),
            favourites: u(favourites),
            running: u(running),
            archived: u(archived),
            trash: u(trash),
            without_client: u(without_client),
            per_client,
        })
    }
}
