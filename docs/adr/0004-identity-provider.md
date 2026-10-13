# 0004 — Identity provider
Status: **Accepted** (protocol and boundaries); vendor and redirect type decided in [ADR-0013](0013-identity-and-authorization.md) (Keycloak reference deployment, private-use-scheme redirect). Date: 2026-10-12. Owner: backend lead.

## Decision
- Desktop login uses **OIDC Authorization Code + PKCE** in the **system browser** with a loopback redirect (native-app best practice), never an embedded login webview and never a client secret in the desktop binary.
- The identity provider authenticates people only. **Tenant membership and roles live in our database** (`memberships`) and are always derived on the server; an `org_id` from a client is a lookup key, never proof of access (implemented in `services/api/src/tenancy.ts`, enforced again by row-level security).
- Users are matched by `(oidc_issuer, oidc_subject)`, never by email alone.
- Separate IdP tenants/applications for dev, staging and prod; `packages/config` refuses dev auth outside dev/test.
- Development uses short-lived HS256 tokens signed with a fixture secret (`pnpm --filter @pb/api dev-token <user>`). This path cannot be enabled in staging/prod.

## Vendor selection (pending)
Criteria: standards-compliant OIDC with PKCE for native apps, MFA, SSO/SAML for business customers, data-residency options matching ADR-0005, pricing at 10,000 organizations, export/migration path, and availability for a US-registered company operating from Nepal. Candidates to evaluate: a managed provider (e.g. Auth0/Okta, Microsoft Entra External ID, AWS Cognito, Zitadel Cloud) or self-hosted Keycloak/Zitadel. Decide in milestone 06.

## Consequences
The API already verifies tokens against the issuer's JWKS discovered from `/.well-known/openid-configuration` (`services/api/src/auth.ts`). User provisioning, invitations and session revocation are milestone 06.
