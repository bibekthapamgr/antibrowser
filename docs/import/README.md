# Profile configuration import and export (schema version 1)

Milestone 04. Decisions: [ADR-0011](../adr/0011-profile-library-and-configuration-import.md).
Engine: `crates/import` (parsing, validation, archive checks, export). Planning and writing: `apps/desktop/src-tauri/src/transfer.rs`.

## What moves and what never does

| Moves (configuration) | Never moves |
|---|---|
| Profile name, client, tags, notes, start pages, camera/microphone/location defaults, favourite, template name | Cookies, sign-ins, passwords, history, site storage, cache, extensions, download folders, local paths, profile ids |

Configuration import is not session migration. Chromium encrypts cookies with a key bound to the device and OS
account (see [ADR-0002](../adr/0002-profile-portability.md) and the [portability matrix](../portability-matrix.md)),
so this format has no place for them, and an export bundle whose manifest claims to carry cookies or other session
data is refused (`SESSION_DATA_NOT_SUPPORTED`).

## Limits

| Limit | Value |
|---|---|
| File size | 20 MB (CSV, JSON or .zip) |
| Rows | 10,000 per file |
| Name, client, template | 1–120 characters |
| Tags | up to 20 per profile, 1–40 characters each |
| Notes | up to 2,000 characters |
| Start pages | up to 10, `http://` or `https://` only |
| Bundle | at most 8 entries, 50 MB unpacked, expansion ratio 100 |

## Formats

### CSV
UTF-8 (a byte-order mark is fine). The first line may be a version line; any other version is refused.

```text
# project-browser profiles v1
name,client,tags,notes,start_urls,camera,microphone,location,favourite,template
Shop admin,Client North,ecommerce;vip,Call the client on Mondays,https://shop.example/admin,block,block,ask,true,
```

- Only `name` is required. Column names are case-insensitive; unknown, empty or repeated columns are refused
  (`BAD_COLUMNS`) so a typo never silently drops data.
- `tags` are separated by `;`, `start_urls` by spaces or new lines. Quoted cells may span lines.
- `camera`, `microphone`, `location`: `ask` (default), `block` or `allow`.
- `favourite`: `true/false`, `yes/no` or `1/0`.
- Cells are never evaluated as formulas. A cell this product exported with a protective `'` before `= + - @`, tab or
  carriage return is read back without it.
- Row numbers in errors are the file's line numbers (the header is line 1, or line 2 after a version line).

### JSON
Schema: [profiles.v1.schema.json](profiles.v1.schema.json).

```json
{
  "format": "project-browser.profiles",
  "schema_version": 1,
  "profiles": [{ "name": "Shop admin", "client": "Client North", "tags": ["ecommerce"], "favourite": true }]
}
```

Unknown top-level keys or profile fields are refused (`unknown_field` for a field, so `"cookies": …` is an error on
that row). `tags` and `start_urls` are arrays of text; `favourite` is a boolean. Row numbers are 1-based positions in
`profiles`.

### Export bundle (.zip)
Written by **Export › Project Browser export**. Exactly two entries: `manifest.json`
(`{"format": "project-browser.export", "schema_version": 1, "contents": ["configuration"], "cookies": false, …}`) and
`profiles.json` (the JSON format above). The archive is refused (`UNSAFE_ARCHIVE`) if it has an absolute path, `..`,
a backslash, a drive letter, a directory or any other entry, a symbolic link, an encrypted entry, more than 8 entries,
more than 50 MB unpacked (counted while reading, not only from the headers), an entry that expands more than 100
times, or executable content (by permission bits or by the start of the file: PE, ELF, Mach-O, `#!`).

## How an import runs

1. **Choose.** The native file dialog returns the path to Rust; the window only receives an opaque 32-hex reference.
2. **Preview (dry run).** Every row is parsed and validated on its own, then planned against the workspace:
   `create`, `update`, `skip_duplicate`, `already_imported` or `error`. Nothing is written except an `import_jobs`
   row in state `previewed`. The preview is bound to the file's SHA-256 and to the chosen settings; changing a
   setting runs a new preview.
3. **Import.** The file is read again; if its SHA-256 differs from the preview, the import is refused
   (`SOURCE_CHANGED`). Rows are written in transactions of 250 with progress after each batch and a cancel check
   between batches. Only one import runs at a time (`IMPORT_IN_PROGRESS`).
4. **Summary and history.** The job records created/updated, skipped and failed counts and up to 1,000 row errors.
   History is under **Downloads and updates › Profile imports**; an import interrupted by quitting the app is marked
   `interrupted` at the next start.

### Duplicates
A duplicate is a row whose name and client match (ignoring case and accents) an existing profile, or an earlier row
of the same file.

| Policy | Effect |
|---|---|
| Skip (default) | The row is skipped; the existing profile is unchanged |
| Update | The existing profile's configuration is replaced by the row's (tags are added); a profile changed after the preview is not overwritten (`changed_since_preview`) |
| Create | Another profile with the same name is created (names need not be unique) |

### Retrying never duplicates
Each created profile records `import_ref = <first 16 hex of the file's SHA-256>:<row>` under a unique index. Running
the same file again after errors, a cancel or a crash reports those rows as `already_imported`; a continued import
also skips update rows it already applied.

## Errors

### File errors (nothing is imported)
| Code | Meaning |
|---|---|
| `FILE_TOO_LARGE` | Over 20 MB |
| `FILE_EMPTY` | No data rows |
| `FILE_NOT_UTF8` | Not UTF-8 text |
| `UNKNOWN_FORMAT` | Not CSV, JSON or a .zip export |
| `UNSUPPORTED_SCHEMA` | Version line or `schema_version` other than 1, or missing in JSON |
| `BAD_COLUMNS` | Missing `name`, unknown, empty or repeated column |
| `TOO_MANY_ROWS` | Over 10,000 rows |
| `MALFORMED_FILE` | CSV or JSON syntax error (with line/column) |
| `UNSAFE_ARCHIVE` | Any archive check above |
| `SESSION_DATA_NOT_SUPPORTED` | A bundle manifest claims cookies/sessions/browser data |

### Row errors (that row is skipped; the others import)
| Code | Fields |
|---|---|
| `required` | `name` |
| `too_long` | name, client, template, tags, notes |
| `invalid_characters` | name, client, template, tags (control or bidirectional-override characters) |
| `invalid_url` | `start_urls` (not http/https) |
| `too_many` | tags (20), start_urls (10) |
| `invalid_value` | camera, microphone, location, favourite |
| `wrong_type` / `unknown_field` | JSON rows |
| `unknown_template` | `template` names no template in the workspace |
| `changed_since_preview` | an update row whose profile changed after the preview |
| `write_failed` | the row could not be saved |

Warnings do not stop a row: notes that look like a password, key, token or card number are **left out** with a
warning ("notes left out …"), because notes are not encrypted.

## Export

**Export…** (bulk bar) writes CSV, JSON or a bundle through the native save dialog, to a temporary name first and
then renamed into place. It contains the configuration fields only. Notes are off by default; when included, notes
that look like secrets are withheld and counted. CSV cells starting with `= + - @`, tab or carriage return get a
leading `'` so spreadsheets show them as text. Every export goes through the authorization placeholder
(`authz::authorize(ExportConfiguration, n)`), which milestones 06/08 replace with a role check.

## Migration adapters

Only formats that are documented or supplied by the user with the right to use them may get an adapter
(`pb_import::ADAPTERS`). Today the adapters are this product's own CSV, JSON and bundle formats. Adding one needs an
ADR naming the documentation or the user's supplied specification, the fields it maps, and its tests. Adapters map
configuration only; none reads another browser's cookie or session stores.

## Examples

| File | Expected result |
|---|---|
| [examples/profiles.csv](examples/profiles.csv) | 5 profiles (lines 3, 4, 5–6, 7, 8), Unicode names, a two-line note |
| [examples/profiles.json](examples/profiles.json) | 4 profiles; the last uses the template "Store manager" (an `unknown_template` error if the workspace has none) |
| [examples/mixed-validity.csv](examples/mixed-validity.csv) | Errors on lines 3 (`name` required), 4 (`invalid_url`), 5 (camera), 10 (tag too long), 11 (favourite); line 6's note is left out; line 7 duplicates line 2; line 8's formula-like name is kept as text; line 9 names a missing template |

`crates/import/tests/examples.rs` parses these files on every CI run, so the table stays true. Malicious archives
(traversal, links, bombs, executables, session data) are generated inside `crates/import/src/tests.rs` rather than
committed.
