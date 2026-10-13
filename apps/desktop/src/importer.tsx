/**
 * Configuration import (choose file → preview/dry run → import with progress and cancel → summary) and export.
 * The webview never sees file paths: the native dialog returns an opaque reference. Only configuration moves in or
 * out (names, clients, tags, notes, start pages, permission defaults); sign-ins, cookies and history never do.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  Backend,
  ExportFormat,
  ImportJob,
  ImportPreview,
  ImportSettings,
  Library,
  Operation,
  Selection,
} from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Dialog, formatBytes, useDebounced } from './components.tsx';
import { day, type Notify, plural, when } from './status.tsx';

const ROW_STATUS: Record<ImportPreview['rows'][number]['status'], string> = {
  create: 'New profile',
  update: 'Updates existing',
  skip_duplicate: 'Skipped (duplicate)',
  already_imported: 'Already imported',
  error: 'Error',
};
export const JOB_STATUS: Record<ImportJob['status'], string> = {
  previewed: 'Previewed',
  running: 'Importing…',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted (app closed)',
};
const FIELD: Record<string, string> = {
  name: 'Name',
  client: 'Client',
  tags: 'Tags',
  notes: 'Notes',
  start_urls: 'Start pages',
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  favourite: 'Favourite',
  template: 'Template',
  row: 'Row',
};

type Phase = 'choose' | 'preview' | 'running' | 'done';

export function ImportDialog(props: {
  backend: Backend;
  notify: Notify;
  library: Library | null;
  refreshKey: number;
  onClose: () => void;
  onImported: () => void;
}) {
  const { backend, notify } = props;
  const [phase, setPhase] = useState<Phase>('choose');
  const [file, setFile] = useState<{ ref: string; name: string; size: number | null } | null>(null);
  const [settings, setSettings] = useState<ImportSettings>({ duplicates: 'skip', default_client: '' });
  const debouncedSettings = useDebounced(settings, 300);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [op, setOp] = useState<Operation | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobId = useRef<string | null>(null);

  // Every settings change re-runs the dry run: the import is bound to the preview the user saw.
  useEffect(() => {
    if (!file) return;
    let live = true;
    setPreviewing(true);
    setError(null);
    backend.transfer
      .preview(file.ref, {
        duplicates: debouncedSettings.duplicates ?? 'skip',
        default_client: debouncedSettings.default_client?.trim() || null,
      })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setPhase('preview');
      })
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setPreviewing(false));
    return () => {
      live = false;
    };
  }, [backend, file, debouncedSettings]);

  useEffect(
    () =>
      backend.on('operation', (o) => {
        if (o.kind !== 'import_profiles' || o.target !== jobId.current) return;
        setOp(o);
        if (o.status !== 'running') {
          props.onImported();
          backend.transfer
            .jobs()
            .then((jobs) => {
              setJob(jobs.find((j) => j.id === jobId.current) ?? null);
              setPhase('done');
            })
            .catch((e) => setError(errorMessage(e)));
        }
      }),
    [backend, props.onImported],
  );

  const choose = async () => {
    setError(null);
    try {
      const f = await backend.transfer.chooseFile();
      if (f.file_ref) {
        setPreview(null);
        setFile({ ref: f.file_ref, name: f.name ?? 'file', size: f.size });
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const start = async () => {
    if (!preview?.preview_id) return;
    setError(null);
    try {
      jobId.current = preview.preview_id;
      setOp(null);
      setJob(null);
      await backend.transfer.commit(preview.preview_id);
      setPhase('running');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const cancel = async () => {
    if (!jobId.current) return;
    try {
      await backend.transfer.cancel(jobId.current);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const importable = preview ? preview.will_create + preview.will_update : 0;
  const close = () => {
    if (phase === 'running')
      notify('The import continues in the background. Its progress is shown in the sidebar.');
    props.onClose();
  };

  return (
    <Dialog
      title="Import profiles"
      description="Imports profile configuration from a CSV or JSON file, or a Project Browser export (.zip). Sign-ins, cookies and browsing history are never imported."
      onClose={close}
      wide
    >
      {phase === 'choose' && (
        <div className="stack">
          <ul className="small plain-list">
            <li>
              CSV or JSON in the documented format (schema version 1), or a configuration export (.zip).
            </li>
            <li>Up to 20 MB and 10,000 rows. Nothing is written until you confirm the preview.</li>
            <li>
              Files are checked for unsafe content: archives with hidden paths, links or programs are refused.
            </li>
          </ul>
          <div className="row">
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              onClick={choose}
              disabled={previewing}
            >
              {previewing ? 'Checking the file…' : 'Choose file…'}
            </button>
          </div>
        </div>
      )}

      {phase === 'preview' && preview && (
        <PreviewPanel
          preview={preview}
          file={file}
          settings={settings}
          onSettings={setSettings}
          previewing={previewing}
          library={props.library}
        />
      )}

      {phase === 'running' && (
        <div className="stack" aria-live="polite">
          <p>
            Importing from <strong>{file?.name}</strong>…
          </p>
          <progress aria-label="Import progress" value={op?.progress ?? undefined} max={1} />
          <p className="muted small">
            {op?.progress != null ? `${Math.round(op.progress * 100)}% done. ` : ''}You can close this window;
            the import continues and its progress stays in the sidebar.
          </p>
        </div>
      )}

      {phase === 'done' && <ResultPanel job={job} op={op} />}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="row row--end">
        {phase === 'preview' && (
          <>
            <button type="button" className="pb-button" onClick={choose}>
              Choose another file…
            </button>
            {!preview?.file_error && (
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                disabled={previewing || importable === 0 || Boolean(preview?.file_error)}
                onClick={start}
              >
                {importable === 0 ? 'Nothing to import' : `Import ${plural(importable, 'profile')}`}
              </button>
            )}
          </>
        )}
        {phase === 'running' && (
          <button type="button" className="pb-button" onClick={cancel}>
            Cancel import
          </button>
        )}
        {phase === 'done' && job?.status === 'cancelled' && (
          <button type="button" className="pb-button" onClick={start}>
            Continue import
          </button>
        )}
        <button type="button" className="pb-button" onClick={close}>
          {phase === 'running' ? 'Hide' : phase === 'done' ? 'Done' : 'Cancel'}
        </button>
      </div>
    </Dialog>
  );
}

function PreviewPanel(props: {
  preview: ImportPreview;
  file: { name: string; size: number | null } | null;
  settings: ImportSettings;
  onSettings: (s: ImportSettings) => void;
  previewing: boolean;
  library: Library | null;
}) {
  const p = props.preview;
  if (p.file_error)
    return (
      <div className="notice notice--error" role="alert">
        <p>
          <strong>{p.file_name}</strong> cannot be imported.
        </p>
        <p>
          {p.file_error.message.charAt(0).toUpperCase()}
          {p.file_error.message.slice(1)}.
        </p>
        <p className="small">Nothing was imported. Check the file or export it again, then choose it here.</p>
      </div>
    );
  const shown = p.rows.slice(0, 50);
  return (
    <div className="stack">
      <p className="small">
        <strong>{p.file_name}</strong>
        {props.file?.size != null ? ` · ${formatBytes(props.file.size)}` : ''} · {p.format?.toUpperCase()} ·
        schema version {p.schema_version} · {plural(p.total, 'row')}
      </p>
      <dl className="summary" aria-busy={props.previewing}>
        <div>
          <dt>New profiles</dt>
          <dd>{p.will_create.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Updates</dt>
          <dd>{p.will_update.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Skipped duplicates</dt>
          <dd>{p.will_skip.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Already imported</dt>
          <dd>{p.already_imported.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Rows with errors</dt>
          <dd className={p.invalid ? 'error' : undefined}>{p.invalid.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Warnings</dt>
          <dd className={p.with_warnings ? 'warn' : undefined}>{p.with_warnings.toLocaleString()}</dd>
        </div>
      </dl>

      <fieldset>
        <legend>When a profile with the same name and client exists</legend>
        {(
          [
            ['skip', 'Skip the row (keep the existing profile)'],
            ['update', 'Update the existing profile (tags are added, other settings replaced)'],
            ['create', 'Create another profile with the same name'],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="choice">
            <input
              type="radio"
              name="duplicates"
              checked={(props.settings.duplicates ?? 'skip') === v}
              onChange={() => props.onSettings({ ...props.settings, duplicates: v })}
            />
            {label}
          </label>
        ))}
        <label>
          Client for rows without one (optional)
          <input
            maxLength={120}
            list="import-clients"
            value={props.settings.default_client ?? ''}
            onChange={(e) => props.onSettings({ ...props.settings, default_client: e.target.value })}
          />
          <datalist id="import-clients">
            {props.library?.clients.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </label>
      </fieldset>

      {(p.new_clients.length > 0 || p.new_tags.length > 0) && (
        <p className="small">
          {p.new_clients.length > 0 && <>New clients: {p.new_clients.join(', ')}. </>}
          {p.new_tags.length > 0 && <>New tags: {p.new_tags.join(', ')}.</>}
        </p>
      )}

      {p.errors.length > 0 && (
        <details open>
          <summary>
            {plural(p.invalid, 'row')} with errors will not be imported
            {p.errors.length >= 1000 ? ' (first 1,000 problems shown)' : ''}
          </summary>
          <div className="scroll-box">
            <table className="simple">
              <caption className="pb-sr-only">Row errors</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Field</th>
                  <th scope="col">Problem</th>
                </tr>
              </thead>
              <tbody>
                {p.errors.map((e) => (
                  <tr key={`${e.row}-${e.field}-${e.code}-${e.message}`}>
                    <td>{e.row}</td>
                    <td>{FIELD[e.field] ?? e.field}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <details>
        <summary>
          Preview rows{' '}
          {p.total > shown.length ? `(first ${shown.length} of ${p.total.toLocaleString()})` : ''}
        </summary>
        <div className="scroll-box">
          <table className="simple">
            <caption className="pb-sr-only">Rows in the file</caption>
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Name</th>
                <th scope="col">Client</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td>{r.name || <span className="muted">(empty)</span>}</td>
                  <td>{r.client ?? '—'}</td>
                  <td>
                    <span className={r.status === 'error' ? 'error' : undefined}>{ROW_STATUS[r.status]}</span>
                    {r.warnings.map((w) => (
                      <span key={w} className="warn small block">
                        {w}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ResultPanel({ job, op }: { job: ImportJob | null; op: Operation | null }) {
  if (!job)
    return (
      <p className={op?.status === 'failed' ? 'error' : undefined}>{op?.message ?? 'The import finished.'}</p>
    );
  return (
    <div className="stack" role="status">
      <p>
        <strong>{JOB_STATUS[job.status]}.</strong> {plural(job.succeeded, 'profile')} imported or updated,{' '}
        {job.skipped.toLocaleString()} skipped, {job.failed.toLocaleString()} with errors.
      </p>
      {job.status === 'cancelled' && (
        <p className="small">
          Rows imported before you cancelled were kept. Continuing imports the rest; rows already imported are
          never added twice.
        </p>
      )}
      {job.errors.length > 0 && (
        <details>
          <summary>{plural(job.errors.length, 'problem')}</summary>
          <ul className="small scroll-box">
            {job.errors.map((e) => (
              <li key={`${e.row}-${e.field}-${e.message}`}>
                Row {e.row} · {FIELD[e.field] ?? e.field}: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ExportDialog(props: {
  backend: Backend;
  notify: Notify;
  selection: Selection;
  count: number;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [notes, setNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`Export ${plural(props.count, 'profile')}`}
      description="Exports configuration only: name, client, tags, start pages, website permissions and template. Sign-ins, cookies, history, local folders and passwords are never exported."
      onClose={props.onClose}
    >
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await props.backend.transfer.export(props.selection, format, notes);
            if (r.path) {
              props.notify(
                `Exported ${plural(r.exported, 'profile')}.${r.notes_withheld ? ` Notes of ${plural(r.notes_withheld, 'profile')} were left out because they look like passwords or keys.` : ''}`,
              );
              props.onClose();
            } else setBusy(false);
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <fieldset>
          <legend>Format</legend>
          {(
            [
              ['csv', 'CSV (spreadsheets; formulas are neutralised)'],
              ['json', 'JSON'],
              ['bundle', 'Project Browser export (.zip)'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="choice">
              <input type="radio" name="format" checked={format === v} onChange={() => setFormat(v)} />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="choice">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
          Include notes
        </label>
        <p className="muted small">
          Off by default. Notes that look like passwords, keys or card numbers are always left out.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
            Export…
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Import history (persistent across restarts; interrupted imports are marked when the app starts again). */
export function ImportHistory(props: { backend: Backend; refreshKey: number; notify: Notify }) {
  const { backend, notify } = props;
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-reads on operation events
  useEffect(() => {
    backend.transfer
      .jobs()
      .then(setJobs)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, props.refreshKey, notify]);
  if (!jobs) return <p role="status">Loading imports…</p>;
  if (!jobs.length) return <p className="muted">No imports yet.</p>;
  return (
    <ul className="ops">
      {jobs.slice(0, 20).map((j) => (
        <li key={j.id} className="job">
          <div>
            <strong>{j.source_name}</strong>{' '}
            <span className="muted small">
              {day(j.created_at)} · {j.format.toUpperCase()}
            </span>
            <span className="block small">
              {plural(j.succeeded, 'profile')} imported, {j.skipped.toLocaleString()} skipped,{' '}
              {j.failed.toLocaleString()} with errors
              {j.finished_at ? ` · finished ${when(j.finished_at)}` : ''}
            </span>
            {j.errors.length > 0 && (
              <details>
                <summary className="small">Problems</summary>
                <ul className="small">
                  {j.errors.slice(0, 50).map((e) => (
                    <li key={`${e.row}-${e.field}-${e.message}`}>
                      Row {e.row} · {FIELD[e.field] ?? e.field}: {e.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <span
            className={
              j.status === 'completed'
                ? 'ok'
                : j.status === 'running'
                  ? 'warn'
                  : j.status === 'failed'
                    ? 'error'
                    : 'warn'
            }
          >
            {JOB_STATUS[j.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}
