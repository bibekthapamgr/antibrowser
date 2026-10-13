/**
 * In-memory stand-in for the shell's shared sessions (milestone 08), for UI development and UI tests. It follows the
 * desktop rules: a linked profile opens only with the session lease (refused, with who has it, when someone else holds
 * it); requests from teammates arrive with heartbeats and never close anything; "Close and hand off" closes the
 * browser, uploads the closing backup under the lease and releases it with the note ("handoff ready" only after the
 * commit); a takeover or removed access closes the browser and keeps this copy aside.
 *
 * Modes (`?demo=`, with `linked`): `requests` (Sam asks for the profile a moment after it opens), `takeover` (an admin
 * takes it over a moment after it opens), `teamoffline` (shared opens are refused: no connection). `inuse` is a
 * demo-cloud mode (Sam has it open elsewhere).
 */
import type { EventPayload, TeamPhase, TeamStatus } from '@pb/contracts/ipc';
import { secretHint } from '../notes.ts';
import type { DemoCloudTeam, DemoTeamRequest } from './demo-cloud.ts';
import type { IpcError, ProfileView, TeamRepository } from './types.ts';

interface Session {
  org: string;
  prf: string;
  phase: TeamPhase;
  error_code: string | null;
  note: string | null;
  received: TeamStatus['received_note'];
  requests: DemoTeamRequest[];
  kept: string | null;
  lastBeat: number;
  timers: ReturnType<typeof setTimeout>[];
}

const err = (code: string, message: string): IpcError => ({ code, message });
const LEASED: TeamPhase[] = ['opening', 'running', 'closing', 'handing_off', 'pending', 'lost'];
const BEAT_MS = 5_000;

const REFUSED: Record<string, string> = {
  PROFILE_IN_USE_ELSEWHERE: 'Someone else has this profile open. You can ask them for it.',
  PROFILE_SESSION_UNCERTAIN:
    'The last session on another computer ended without closing; its browser may still be open. Ask that person to open the app, or an admin to take the profile over.',
  NO_ACCESS: 'You do not have access to open this profile. Ask an admin.',
  SHARED_OFFLINE:
    "Organization profiles open only when this computer can reach your organization's server. Profiles on this computer only work as usual.",
};

export function demoTeam(deps: {
  mode: string;
  cloud: DemoCloudTeam;
  linkOf: (id: string) => { org_id: string; org_profile_id: string } | null;
  isOpen: (id: string) => boolean;
  /** Closes the browser as "Close profile" does. */
  stop: (id: string) => void;
  closingBackup: (id: string) => Promise<'committed' | 'conflict' | 'waiting' | 'canceled' | 'failed'>;
  createCopy: (name: string) => ProfileView;
  emit: (p: EventPayload<'team'>) => void;
  changed: () => void;
}): TeamRepository & {
  /** Before a linked profile's browser starts: the lease, or why not. */
  open(id: string): IpcError | null;
  opened(id: string): void;
  /** The browser closed; true when the shared session handles it (no automatic backup). */
  closed(id: string, clean: boolean): boolean;
  phase(id: string): TeamPhase | null;
  guardEdit(id: string, syncedSettings: boolean): void;
} {
  const sessions = new Map<string, Session>();
  const refusals = new Map<string, TeamStatus['refusal']>();

  const setPhase = (id: string, s: Session, phase: TeamPhase, code: string | null = null) => {
    s.phase = phase;
    s.error_code = code;
    deps.emit({ profile_id: id, kind: 'phase', phase, error_code: code });
    deps.changed();
  };
  const end = (id: string) => {
    const s = sessions.get(id);
    for (const t of s?.timers ?? []) clearTimeout(t);
    sessions.delete(id);
    deps.emit({ profile_id: id, kind: 'phase', phase: null });
    deps.changed();
  };

  const lost = (id: string, s: Session, phase: 'taken_over' | 'revoked') => {
    for (const t of s.timers) clearTimeout(t);
    s.timers = [];
    setPhase(id, s, phase, phase === 'revoked' ? 'ACCESS_REMOVED' : 'TAKEN_OVER');
    if (deps.isOpen(id)) deps.stop(id);
    else settle(id, s);
  };

  /** Once the browser is closed: this copy is kept aside; after a takeover it becomes a recovery copy. */
  const settle = (id: string, s: Session) => {
    if (s.kept) return;
    s.kept = `${Math.floor(Date.now() / 1000)}-${s.phase === 'revoked' ? 'access-removed' : 'taken-over'}`;
    deps.emit({ profile_id: id, kind: 'kept_aside', phase: s.phase });
    if (s.phase === 'taken_over')
      setTimeout(() => {
        deps.cloud.keepRecovery(s.org, s.prf);
        s.error_code = 'RECOVERY_COPY_KEPT';
        deps.emit({ profile_id: id, kind: 'recovery_kept' });
        deps.changed();
      }, 600);
    deps.changed();
  };

  const beat = (id: string) => {
    const s = sessions.get(id);
    if (!s || !LEASED.includes(s.phase)) return;
    const runState =
      s.phase === 'running'
        ? 'running'
        : s.phase === 'opening'
          ? 'restoring'
          : s.phase === 'closing'
            ? 'stopping'
            : 'uploading';
    const b = deps.cloud.beat(s.org, s.prf, runState);
    if (b.state === 'taken_over' || b.state === 'revoked') return lost(id, s, b.state);
    if (b.state !== 'active') return;
    s.lastBeat = Date.now();
    const known = new Set(s.requests.map((r) => r.id));
    s.requests = b.requests;
    if (b.requests.some((r) => !known.has(r.id)))
      deps.emit({ profile_id: id, kind: 'requests', requests: b.requests });
  };
  const schedule = (id: string, s: Session) => {
    const loop = () => {
      beat(id);
      if (sessions.get(id) === s && LEASED.includes(s.phase)) s.timers.push(setTimeout(loop, BEAT_MS));
    };
    s.timers.push(setTimeout(loop, BEAT_MS));
    if (deps.mode.includes('requests'))
      s.timers.push(
        setTimeout(() => {
          deps.cloud.teammateAsks(s.org, s.prf, 'Need it for the refund queue');
          beat(id);
        }, 1_500),
      );
    if (deps.mode.includes('takeover'))
      s.timers.push(
        setTimeout(() => {
          deps.cloud.adminTakesOver(s.org, s.prf);
          beat(id);
        }, 2_000),
      );
  };

  const handoff = (id: string, s: Session) => {
    setPhase(id, s, 'handing_off', s.phase === 'lost' ? 'CONNECTION_LOST' : null);
    void deps.closingBackup(id).then((r) => {
      if (sessions.get(id) !== s || s.phase !== 'handing_off') return;
      if (r === 'committed') {
        deps.cloud.release(s.org, s.prf, s.note);
        end(id);
        deps.emit({ profile_id: id, kind: 'handoff_ready' });
      } else if (r === 'conflict') setPhase(id, s, 'pending', 'VERSION_CONFLICT');
      else if (r === 'canceled') setPhase(id, s, 'pending', 'UPLOAD_CANCELED');
      else if (r === 'failed') setPhase(id, s, 'pending', 'UPLOAD_FAILED');
      // waiting: stays handing_off until the connection is back (Retry).
    });
  };

  const view = (id: string): TeamStatus => {
    const link = deps.linkOf(id);
    const s = sessions.get(id);
    return {
      profile_id: id,
      shared: !!link,
      phase: s?.phase ?? null,
      error_code: s?.error_code ?? null,
      requests: s && LEASED.includes(s.phase) ? s.requests.map((r) => ({ ...r })) : [],
      received_note: s?.received ?? null,
      handoff_note: s?.note ?? null,
      kept_aside: s?.kept ?? null,
      refusal: refusals.get(id) ?? null,
      capabilities: link ? deps.cloud.capabilities(link.org_id, link.org_profile_id) : null,
      heartbeat_age_seconds:
        s && LEASED.includes(s.phase) ? Math.max(0, Math.round((Date.now() - s.lastBeat) / 1000)) : null,
    };
  };
  const need = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw err('TEAM_NO_SESSION', 'This profile is not open as a shared session on this computer.');
    return s;
  };
  const cleanNote = (note: string | null) => {
    const n = (note ?? '').trim();
    if (!n) return null;
    if ([...n].length > 500)
      throw err('HANDOFF_NOTE_INVALID', 'Handoff notes are plain text of up to 500 characters.');
    if (secretHint(n))
      throw err(
        'NOTES_LOOK_SECRET',
        'This looks like a password or key. Notes are not encrypted; use a password manager.',
      );
    return n;
  };

  return {
    async status(id) {
      return view(id);
    },
    async close(id, note) {
      const s = need(id);
      if (!LEASED.includes(s.phase))
        throw err('SESSION_ENDED', "This profile's session here ended (taken over, or access removed).");
      s.note = cleanNote(note);
      if (deps.isOpen(id)) {
        if (s.phase === 'running') setPhase(id, s, 'closing');
        deps.stop(id);
      } else if (s.phase === 'pending' || s.phase === 'lost') handoff(id, s);
      return view(id);
    },
    async abort(id) {
      const s = need(id);
      if (deps.isOpen(id)) throw err('SYNC_PROFILE_NOT_CLOSED', 'Close the profile first.');
      if (!LEASED.includes(s.phase))
        throw err('SESSION_ENDED', "This profile's session here ended (taken over, or access removed).");
      deps.cloud.release(s.org, s.prf, null);
      end(id);
      return view(id);
    },
    async retry(id) {
      const s = need(id);
      if (deps.isOpen(id)) throw err('SYNC_PROFILE_NOT_CLOSED', 'Close the profile first.');
      if (s.phase === 'pending' && s.error_code === 'PROFILE_CLOSED_UNCLEANLY')
        throw err(
          'SESSION_NEEDS_REOPEN',
          'The profile did not close normally. Open it again, or give the handoff up and keep this copy.',
        );
      if (!['pending', 'handing_off', 'lost'].includes(s.phase))
        throw err('SESSION_ENDED', "This profile's session here ended (taken over, or access removed).");
      handoff(id, s);
      return view(id);
    },
    async dismiss(id) {
      const s = need(id);
      if (LEASED.includes(s.phase))
        throw err(
          'TEAM_SESSION_ACTIVE',
          'The session is still active. Close and hand off the profile, or give the handoff up.',
        );
      end(id);
      return view(id);
    },
    async restoreRecoveryCopy(_orgId, _orgProfileId, _snapshotId, name) {
      return deps.createCopy(name);
    },
    open(id) {
      const link = deps.linkOf(id);
      if (!link) return null;
      const cur = sessions.get(id);
      if (cur && !LEASED.includes(cur.phase))
        return err(
          'SESSION_ENDED',
          "This profile's session here ended (taken over, or access removed). Dismiss the notice first.",
        );
      if (cur) return null; // still ours: reopen under the same lease
      if (deps.mode.includes('teamoffline')) return err('SHARED_OFFLINE', REFUSED.SHARED_OFFLINE ?? '');
      const r = deps.cloud.open(link.org_id, link.org_profile_id);
      if ('refused' in r) {
        if (r.refused !== 'NO_ACCESS')
          refusals.set(id, {
            code: r.refused,
            holder_name: r.holder_name,
            device_name: r.device_name,
            since: r.since,
          });
        deps.changed();
        return err(r.refused, REFUSED[r.refused] ?? 'This profile cannot be opened now.');
      }
      refusals.delete(id);
      sessions.set(id, {
        org: link.org_id,
        prf: link.org_profile_id,
        phase: 'opening',
        error_code: null,
        note: null,
        received: r.note,
        requests: [],
        kept: null,
        lastBeat: Date.now(),
        timers: [],
      });
      deps.emit({ profile_id: id, kind: 'phase', phase: 'opening', error_code: null });
      return null;
    },
    opened(id) {
      const s = sessions.get(id);
      if (!s) return;
      for (const t of s.timers) clearTimeout(t);
      s.timers = [];
      setPhase(id, s, 'running');
      schedule(id, s);
    },
    closed(id, clean) {
      const s = sessions.get(id);
      if (!s) return false;
      if (s.phase === 'taken_over' || s.phase === 'revoked') {
        settle(id, s);
        return true;
      }
      if (!clean) {
        setPhase(id, s, 'pending', 'PROFILE_CLOSED_UNCLEANLY');
        return true;
      }
      handoff(id, s);
      return true;
    },
    phase(id) {
      return sessions.get(id)?.phase ?? null;
    },
    guardEdit(id, syncedSettings) {
      const s = sessions.get(id);
      if (s && ['lost', 'taken_over', 'revoked'].includes(s.phase))
        throw err(
          'SESSION_PAUSED',
          'Changes are paused while this computer cannot confirm it still holds the profile.',
        );
      const link = deps.linkOf(id);
      if (
        syncedSettings &&
        link &&
        !deps.cloud.capabilities(link.org_id, link.org_profile_id).includes('edit')
      )
        throw err(
          'NO_EDIT_CAPABILITY',
          'Your access to this organization profile does not include changing its settings.',
        );
    },
  };
}
