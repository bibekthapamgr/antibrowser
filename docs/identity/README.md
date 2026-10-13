# Identity, organizations and authorization (milestone 06)

| Document | What it covers |
|---|---|
| [ADR-0013](../adr/0013-identity-and-authorization.md) | Decisions: OIDC with Keycloak as the reference, PKCE in the system browser, device-bound sessions, roles and grants, two-layer tenancy, invitations, ownership, audit, rate limits, local→organization copy |
| [schema.md](schema.md) | Tables, keys, row-level security policies and definer functions |
| [Permission matrix](../permission-matrix.md) | Role × permission table and how a request is decided (generated from the contracts) |
| [OpenAPI](../openapi.json) | Every endpoint, with request and response schemas |
| [authentication-threat-review.md](authentication-threat-review.md) | Threats, controls and the tests that prove them; residual risks |
| [tenant-isolation-report.md](tenant-isolation-report.md) | Exit-gate evidence: id swaps on every endpoint, pooled connections, revocation, last owner, invitations |
| [keycloak-setup.md](keycloak-setup.md) | Setting up the identity provider and the API's session key |

## Journeys and where they live

| Journey | Desktop | API |
|---|---|---|
| Sign up / sign in | Account → Sign in or create an account (system browser) | `GET /v1/auth/config`, `POST /v1/devices`, `POST /v1/auth/token` |
| Verify account | Shown on Account until the provider reports a verified e-mail | `email_verified` from the ID token |
| Create organization | Account → Create an organization | `POST /v1/organizations` |
| Switch workspace | Sidebar: “On this computer” and “Organizations” | `GET /v1/me/workspaces` |
| Invite member | Organization → Invitations (code shown once) | `POST /v1/orgs/{org}/invitations` |
| Accept invite | Account → Join an organization | `GET/POST /v1/invitations/{token}[/accept]` |
| Enroll device | Automatic at the first sign-in on a computer | `POST /v1/devices` |
| Sign out / revoke device | Account → Sign out; Your devices → Sign out device | `POST /v1/auth/sign-out`, `POST /v1/devices/{id}/revoke` |
| Roles and access | Organization → Members, Access | `PATCH/DELETE /v1/orgs/{org}/members/{user}`, `/grants`, `/ownership-transfer` |
| Copy a local workspace | Organization → Settings → Copy profiles from this computer (preview, client mapping, copy) | `POST /v1/orgs/{org}/local-import` |

## Known limitations

1. **Organization profiles cannot be opened on a computer yet.** They are shared settings (name, client, notes) in
   this milestone; browser data stays on the computer where it was created. Encrypted sync arrives in milestone 07
   and opening/handoff with leases in 08. The desktop never opens anything from cached organization data.
2. **Invitation codes are delivered by the inviter** (copy and send); the server does not send e-mail.
3. **One organization server per installation.** Changing it signs the computer out and forgets the cached
   organization data (local profiles stay).
4. **Device names are generic** (“Project Browser on Windows”); renaming devices comes later.
5. **Some API features have no screen yet:** bulk changes and the configuration export of organization profiles
   (owners and admins can use the API), the account-level audit (sign-ins, device revocations).
6. **A refresh answer lost in transit ends the session** at the next refresh (rotation with reuse detection); signing in
   again is enough, nothing local is lost.
7. **Without a working keychain** the session is kept in memory only and ends when the manager closes.
