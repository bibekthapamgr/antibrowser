# R7 — Account gate (sign-in and plan required)

Owner decision (2026-10-15): the desktop app is used with an account and a usable workspace plan. Before that it shows
only full-window screens (`apps/desktop/src/gate.tsx`):

| Situation | Screen |
|---|---|
| Signed out, or the session ended | **Welcome**: Sign in / Create account (both open the sign-in page in the browser; the app never sees the password). The server is built in (`PB_DEFAULT_SERVER`); "Change" shows the address field. |
| Signed in, no workspace yet | **Set up your workspace**: onboarding (terms → new workspace with a trial, or a waiting invitation). |
| Signed in, no workspace with a usable plan (`trial`, `active`, `past_due`, `grace`) | **Choose a plan** (owners and billing members see the subscription screen; others are asked to contact the owner). |
| Signed in, server unreachable | Works for 7 days after the last confirmed plan; after that **Can't reach the server**. |

The plan is checked at start, on account changes and every 15 minutes. There is no "This computer" view while the
gate is on (local-only profiles would sit outside every plan limit): profiles made on this computer before are
counted, and the workspace's Profiles page offers to move them in ("Move into <workspace>…", within the plan's profile
limit; sign-ins inside them are kept). New profiles are always workspace profiles, whose limits the server enforces.

Limits: the gate runs on the customer's computer, so it is a product boundary, not tamper-proof copy protection; what
a plan pays for that lives on the server (workspace profiles beyond the limit, sync, backups, team sharing,
automation) stays enforced by the server regardless.

Build default server: a build's `PB_DEFAULT_SERVER` is applied whenever no server is set; a newer build's server
replaces the previous build's server when the person never changed it (one sign-out; local data stays); a server the
person chose stays.

Tests: `account gate` e2e suite (demo flag `gate`), `a_build_default_server_is_applied_when_unset…` (Rust).
