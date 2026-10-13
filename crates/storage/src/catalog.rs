//! Clients (shown as folders), tags, configuration templates and saved filters (milestone 04).
//!
//! Names are unique per workspace ignoring case (Unicode-aware); generated ids are always unique. Profile names are
//! deliberately NOT unique.

use crate::migrations::name_key;
use crate::{LocalStore, StoreError};
use pb_runtime::{ClientId, FilterId, PermissionDefault, TagId, TemplateId, WorkspaceId};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Client {
    pub id: ClientId,
    pub workspace_id: WorkspaceId,
    pub name: String,
    pub colour: Option<String>,
    pub archived_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    /// Where this client's profiles download to (milestone 09); `None`: the usual folder.
    pub download_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Tag {
    pub id: TagId,
    pub name: String,
    /// Profiles (not in the trash) carrying the tag.
    pub profiles: u64,
}

/// Configuration a template carries. Never browser storage, sign-ins or secrets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateConfig {
    #[serde(default)]
    pub start_urls: Vec<String>,
    #[serde(default = "ask")]
    pub camera: PermissionDefault,
    #[serde(default = "ask")]
    pub microphone: PermissionDefault,
    #[serde(default = "ask")]
    pub location: PermissionDefault,
    /// Tag names (created on use if missing).
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

fn ask() -> PermissionDefault {
    PermissionDefault::Ask
}

pub const TEMPLATE_SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Template {
    pub id: TemplateId,
    pub name: String,
    pub schema_version: i64,
    pub config: TemplateConfig,
    pub version: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SavedFilter {
    pub id: FilterId,
    pub name: String,
    pub filter: serde_json::Value,
    pub created_at: String,
}

fn parse_id<T, E>(s: &str, parse: impl Fn(&str) -> Result<T, E>) -> Result<T, StoreError> {
    parse(s).map_err(|_| StoreError::Corrupt)
}

fn unique_violation(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _)
        if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
            || f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY)
}

fn map_unique(e: rusqlite::Error) -> StoreError {
    if unique_violation(&e) {
        StoreError::Duplicate
    } else {
        StoreError::Sql(e)
    }
}

impl LocalStore {
    // ------------------------------------------------------------------ clients
    pub fn list_clients(
        &self,
        workspace: &WorkspaceId,
        include_archived: bool,
    ) -> Result<Vec<Client>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select id, workspace_id, name, colour, archived_at, version, created_at, download_dir from clients_local
              where workspace_id = ?1 and (?2 or archived_at is null)
              order by name_key, id limit 5000",
        )?;
        let rows = stmt.query_map(params![workspace.as_str(), include_archived], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })?;
        rows.map(|r| {
            let (id, ws, name, colour, archived_at, version, created_at, download_dir) = r?;
            Ok(Client {
                id: parse_id(&id, ClientId::parse)?,
                workspace_id: parse_id(&ws, WorkspaceId::parse)?,
                name,
                colour,
                archived_at,
                version,
                created_at,
                download_dir,
            })
        })
        .collect()
    }

    pub fn get_client(&self, id: &ClientId) -> Result<Option<Client>, StoreError> {
        let conn = self.r()?;
        let row = conn
            .query_row(
                "select id, workspace_id, name, colour, archived_at, version, created_at, download_dir
                   from clients_local where id = ?1",
                [id.as_str()],
                |r| {
                    Ok((
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(ws, name, colour, archived_at, version, created_at, download_dir)| {
                Ok(Client {
                    id: id.clone(),
                    workspace_id: parse_id(&ws, WorkspaceId::parse)?,
                    name,
                    colour,
                    archived_at,
                    version,
                    created_at,
                    download_dir,
                })
            },
        )
        .transpose()
    }

    pub fn find_client(
        &self,
        workspace: &WorkspaceId,
        name: &str,
    ) -> Result<Option<ClientId>, StoreError> {
        let conn = self.r()?;
        conn.query_row(
            "select id from clients_local where workspace_id = ?1 and name_key = ?2",
            params![workspace.as_str(), name_key(name)],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(|id| parse_id(&id, ClientId::parse))
        .transpose()
    }

    pub fn create_client(
        &self,
        workspace: &WorkspaceId,
        name: &str,
        colour: Option<&str>,
    ) -> Result<Client, StoreError> {
        let id = ClientId::generate().map_err(|_| StoreError::Corrupt)?;
        self.w()?
            .execute(
                "insert into clients_local (id, workspace_id, name, name_key, colour) values (?1, ?2, ?3, ?4, ?5)",
                params![id.as_str(), workspace.as_str(), name.trim(), name_key(name), colour],
            )
            .map_err(map_unique)?;
        self.get_client(&id)?.ok_or(StoreError::Corrupt)
    }

    /// Returns the existing client with this name (any case) or creates it.
    pub fn ensure_client(
        &self,
        workspace: &WorkspaceId,
        name: &str,
    ) -> Result<ClientId, StoreError> {
        if let Some(id) = self.find_client(workspace, name)? {
            return Ok(id);
        }
        match self.create_client(workspace, name, None) {
            Ok(c) => Ok(c.id),
            Err(StoreError::Duplicate) => self
                .find_client(workspace, name)?
                .ok_or(StoreError::Corrupt),
            Err(e) => Err(e),
        }
    }

    /// Renames, recolours or (un)archives a client. `colour: Some(None)` clears the colour.
    pub fn update_client(
        &self,
        id: &ClientId,
        expected_version: i64,
        name: Option<&str>,
        colour: Option<Option<&str>>,
        archived: Option<bool>,
    ) -> Result<Client, StoreError> {
        let n = self
            .w()?
            .execute(
                "update clients_local set
                   name = coalesce(?3, name),
                   name_key = coalesce(?4, name_key),
                   colour = case when ?5 then ?6 else colour end,
                   archived_at = case when ?7 is null then archived_at
                                      when ?7 then coalesce(archived_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                                      else null end,
                   version = version + 1,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 where id = ?1 and version = ?2",
                params![
                    id.as_str(),
                    expected_version,
                    name.map(str::trim),
                    name.map(name_key),
                    colour.is_some(),
                    colour.flatten(),
                    archived,
                ],
            )
            .map_err(map_unique)?;
        if n == 0 {
            return match self.get_client(id)? {
                Some(c) => Err(StoreError::VersionConflict { current: c.version }),
                None => Err(StoreError::NotFound),
            };
        }
        self.get_client(id)?.ok_or(StoreError::Corrupt)
    }

    // ------------------------------------------------------------------ tags
    pub fn list_tags(&self, workspace: &WorkspaceId) -> Result<Vec<Tag>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select t.id, t.name,
                    (select count(*) from profile_tags pt
                       where pt.tag_id = t.id
                         and not exists (select 1 from trash_entries te where te.profile_id = pt.profile_id))
               from tags t where t.workspace_id = ?1 order by t.name_key, t.id limit 5000",
        )?;
        let rows = stmt.query_map([workspace.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        rows.map(|r| {
            let (id, name, n) = r?;
            Ok(Tag {
                id: parse_id(&id, TagId::parse)?,
                name,
                profiles: n.max(0) as u64,
            })
        })
        .collect()
    }

    pub fn tag_workspace(&self, id: &TagId) -> Result<Option<WorkspaceId>, StoreError> {
        self.r()?
            .query_row(
                "select workspace_id from tags where id = ?1",
                [id.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|w| parse_id(&w, WorkspaceId::parse))
            .transpose()
    }

    /// Returns the existing tag with this name (any case) or creates it.
    pub fn ensure_tag(
        &self,
        workspace: &WorkspaceId,
        name: &str,
    ) -> Result<TagRefOwned, StoreError> {
        let key = name_key(name);
        let find = |store: &Self| -> Result<Option<TagRefOwned>, StoreError> {
            store
                .r()?
                .query_row(
                    "select id, name from tags where workspace_id = ?1 and name_key = ?2",
                    params![workspace.as_str(), key],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
                .map(|(id, name)| {
                    Ok(TagRefOwned {
                        id: parse_id(&id, TagId::parse)?,
                        name,
                    })
                })
                .transpose()
        };
        if let Some(t) = find(self)? {
            return Ok(t);
        }
        let id = TagId::generate().map_err(|_| StoreError::Corrupt)?;
        match self.w()?.execute(
            "insert into tags (id, workspace_id, name, name_key) values (?1, ?2, ?3, ?4)",
            params![id.as_str(), workspace.as_str(), name.trim(), key],
        ) {
            Ok(_) => Ok(TagRefOwned {
                id,
                name: name.trim().to_owned(),
            }),
            Err(e) if unique_violation(&e) => find(self)?.ok_or(StoreError::Corrupt),
            Err(e) => Err(e.into()),
        }
    }

    pub fn rename_tag(&self, id: &TagId, name: &str) -> Result<(), StoreError> {
        let n = self
            .w()?
            .execute(
                "update tags set name = ?2, name_key = ?3 where id = ?1",
                params![id.as_str(), name.trim(), name_key(name)],
            )
            .map_err(map_unique)?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Deletes a tag and removes it from every profile.
    pub fn delete_tag(&self, id: &TagId) -> Result<(), StoreError> {
        self.w()?
            .execute("delete from tags where id = ?1", [id.as_str()])?;
        Ok(())
    }

    // ------------------------------------------------------------------ templates
    pub fn list_templates(&self, workspace: &WorkspaceId) -> Result<Vec<Template>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select id, name, schema_version, config_json, version, updated_at from templates
              where workspace_id = ?1 order by name, id limit 1000",
        )?;
        let rows = stmt.query_map([workspace.as_str()], row_to_template)?;
        rows.map(|r| r.map_err(StoreError::from).and_then(|x| x))
            .collect()
    }

    pub fn get_template(
        &self,
        id: &TemplateId,
    ) -> Result<Option<(WorkspaceId, Template)>, StoreError> {
        let conn = self.r()?;
        let ws: Option<String> = conn
            .query_row(
                "select workspace_id from templates where id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(ws) = ws else { return Ok(None) };
        let t = conn
            .query_row(
                "select id, name, schema_version, config_json, version, updated_at from templates where id = ?1",
                [id.as_str()],
                row_to_template,
            )?
            ?;
        Ok(Some((parse_id(&ws, WorkspaceId::parse)?, t)))
    }

    pub fn save_template(
        &self,
        workspace: &WorkspaceId,
        name: &str,
        config: &TemplateConfig,
    ) -> Result<Template, StoreError> {
        let id = TemplateId::generate().map_err(|_| StoreError::Corrupt)?;
        let json = serde_json::to_string(config).map_err(|_| StoreError::Corrupt)?;
        self.w()?.execute(
            "insert into templates (id, workspace_id, name, schema_version, config_json) values (?1, ?2, ?3, ?4, ?5)",
            params![id.as_str(), workspace.as_str(), name.trim(), TEMPLATE_SCHEMA_VERSION, json],
        )?;
        Ok(self.get_template(&id)?.ok_or(StoreError::Corrupt)?.1)
    }

    pub fn delete_template(&self, id: &TemplateId) -> Result<(), StoreError> {
        self.w()?
            .execute("delete from templates where id = ?1", [id.as_str()])?;
        Ok(())
    }

    // ------------------------------------------------------------------ saved filters
    pub fn list_saved_filters(
        &self,
        workspace: &WorkspaceId,
    ) -> Result<Vec<SavedFilter>, StoreError> {
        let conn = self.r()?;
        let mut stmt = conn.prepare_cached(
            "select id, name, filter_json, created_at from saved_filters
              where workspace_id = ?1 order by name, id limit 200",
        )?;
        let rows = stmt.query_map([workspace.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        rows.map(|r| {
            let (id, name, json, created_at) = r?;
            Ok(SavedFilter {
                id: parse_id(&id, FilterId::parse)?,
                name,
                filter: serde_json::from_str(&json).map_err(|_| StoreError::Corrupt)?,
                created_at,
            })
        })
        .collect()
    }

    pub fn save_filter(
        &self,
        workspace: &WorkspaceId,
        name: &str,
        filter: &serde_json::Value,
    ) -> Result<SavedFilter, StoreError> {
        let id = FilterId::generate().map_err(|_| StoreError::Corrupt)?;
        let count: i64 = self.r()?.query_row(
            "select count(*) from saved_filters where workspace_id = ?1",
            [workspace.as_str()],
            |r| r.get(0),
        )?;
        if count >= 200 {
            return Err(StoreError::Invalid("at most 200 saved filters"));
        }
        self.w()?.execute(
            "insert into saved_filters (id, workspace_id, name, filter_json) values (?1, ?2, ?3, ?4)",
            params![id.as_str(), workspace.as_str(), name.trim(), filter.to_string()],
        )?;
        self.list_saved_filters(workspace)?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or(StoreError::Corrupt)
    }

    pub fn delete_saved_filter(&self, id: &FilterId) -> Result<(), StoreError> {
        self.w()?
            .execute("delete from saved_filters where id = ?1", [id.as_str()])?;
        Ok(())
    }
}

/// A tag reference returned by [`LocalStore::ensure_tag`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TagRefOwned {
    pub id: TagId,
    pub name: String,
}

fn row_to_template(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Template, StoreError>> {
    let id: String = r.get(0)?;
    let json: String = r.get(3)?;
    Ok((|| {
        Ok(Template {
            id: parse_id(&id, TemplateId::parse)?,
            name: r.get(1)?,
            schema_version: r.get(2)?,
            config: serde_json::from_str(&json).map_err(|_| StoreError::Corrupt)?,
            version: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })())
}
