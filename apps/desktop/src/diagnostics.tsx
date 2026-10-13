/**
 * Diagnostics report export (milestone 09): the person sees exactly what would be saved — redacted, size-limited —
 * before choosing where to save it. Nothing is sent anywhere by the app.
 */
import { useState } from 'react';
import type { Backend, DiagnosticsPreview } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Dialog, formatBytes } from './components.tsx';
import { type Notify, plural } from './status.tsx';

const REDACTION_LABELS: [keyof DiagnosticsPreview['redactions'], string, string][] = [
  ['addresses', 'web address', 'web addresses'],
  ['emails', 'e-mail address', 'e-mail addresses'],
  ['ip_addresses', 'IP address', 'IP addresses'],
  ['paths', 'home folder path', 'home folder paths'],
  ['user_names', 'user name', 'user names'],
  ['secrets', 'password or key', 'passwords or keys'],
  ['tokens', 'access token', 'access tokens'],
];

export function DiagnosticsExport(props: { backend: Backend; notify: Notify; label?: string }) {
  const { backend, notify } = props;
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      setPreview(await backend.agency.previewDiagnostics());
    } catch (e) {
      notify(errorMessage(e, 'The report could not be prepared.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const removed = preview
    ? REDACTION_LABELS.filter(([k]) => preview.redactions[k] > 0).map(([k, one, many]) =>
        plural(preview.redactions[k], one, many),
      )
    : [];
  return (
    <>
      <button type="button" className="pb-button" onClick={open} disabled={busy}>
        {props.label ?? 'Preview and save report…'}
      </button>
      {preview && (
        <Dialog
          wide
          title="Diagnostics report"
          description="This is exactly what will be saved. Nothing is sent anywhere: you choose where the file goes and whom to give it to."
          onClose={() => setPreview(null)}
        >
          <div className="stack">
            <p className="small">
              {formatBytes(preview.bytes)} of at most {formatBytes(preview.limit_bytes)}.
              {preview.truncated ? ' The longest lists were shortened to stay under the limit.' : ''}{' '}
              {removed.length > 0
                ? `Removed: ${removed.join(', ')}.`
                : 'Nothing personal was found to remove.'}{' '}
              Profiles appear by id only; proxy addresses, logins, page addresses and notes are never
              included.
            </p>
            <label>
              Report contents
              <textarea className="mono report-preview" readOnly value={preview.text} rows={16} />
            </label>
            <p className="muted small">
              The preview is kept for {Math.round(preview.expires_in_seconds / 60)} minutes, then forgotten.
            </p>
            <div className="row row--end">
              <button type="button" className="pb-button" onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                onClick={async () => {
                  try {
                    const r = await backend.agency.exportDiagnostics(preview.preview_id);
                    if (r.path) {
                      notify(`Diagnostics saved to ${r.path}.`);
                      setPreview(null);
                    }
                  } catch (e) {
                    notify(errorMessage(e), 'error');
                    setPreview(null);
                  }
                }}
              >
                Save…
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
