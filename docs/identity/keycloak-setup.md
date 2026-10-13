# Setting up the identity provider (Keycloak)

Project Browser signs people in with standard OpenID Connect. Keycloak is the reference provider (ADR-0013): it is
free, open source and can run on your own server. A managed provider works too if it supports a public client with
PKCE, a `projectbrowser://auth/callback` redirect, `nonce`, `email_verified` and `auth_time`.

## Quick start: the test server (one command)

On a server prepared with `scripts/deploy/vps-setup.sh`, `scripts/deploy/keycloak-setup.sh` does everything below
for a private setup and connects the API:

```bash
# on the server, as root (after vps-setup.sh)
\cp -f /home/pb/antibrowser/scripts/deploy/keycloak-setup.sh /root/
bash /root/keycloak-setup.sh --owner-email you@example.com      # prints your temporary password once
bash /root/keycloak-setup.sh add-user teammate@example.com       # more accounts
bash /root/keycloak-setup.sh reset-password teammate@example.com # forgotten password or locked account
```

What it sets up:

| Part | Setting |
|---|---|
| Java | the distribution's OpenJDK 21 (Eclipse Temurin 21 JRE, checksum verified, where the distribution has none) |
| Keycloak | 26.6.2 from the official release, SHA-256 pinned in the script, in `/opt/keycloak-26.6.2` (`/opt/keycloak` links to it); systemd service `keycloak`, user `keycloak`, hardened like `pb-api`; heap 512 MB |
| Mode | production mode (`start --optimized`), single node (`cache=local`), its own PostgreSQL database and role (random password) |
| Network | plain HTTP on `127.0.0.1:8081` only (checked: nothing listens publicly); reached through the SSH tunnel. Firewall and SSH settings are untouched |
| Realm | `project-browser`: no self-registration, brute-force protection, passwords of 12+ characters, not the e-mail address, not one of the last three. Created once; later runs leave its settings to you |
| Client | `project-browser-desktop`: public, Authorization Code only, PKCE S256 required, redirect `projectbrowser://auth/callback` only. Enforced on every run |
| Accounts | made by the script, e-mail marked verified (the server sends no e-mail), temporary password shown once and replaced at the first sign-in; `--otp` also requires an authenticator app |
| API | `/etc/project-browser/oidc.env` (issuer, client id, a persistent `SESSION_SIGNING_KEY`; root only) loaded by the drop-in `/etc/systemd/system/pb-api.service.d/oidc.conf`. `vps-setup.sh` regenerates `api.env` but never touches these, so updates keep sign-in and existing sessions |
| Admin console | `http://127.0.0.1:8081/admin/` through the tunnel, user `admin`, password in `/etc/project-browser/keycloak-admin` (root only) |

Re-running it is safe (it only restarts what changed). CI runs both server scripts on a fresh Ubuntu 24.04 VM, signs
in through the deployed API like the desktop does, then re-runs both scripts and checks that the session survives
(`.github/workflows/deploy-scripts.yml`).

This setup is private: plain HTTP is accepted only on loopback addresses, and the API runs with `APP_ENV=dev`.
Making sign-in reachable for a team without tunnels needs a domain, HTTPS (a reverse proxy holding the certificate),
`APP_ENV=staging|prod` for the API — which also needs the object storage of milestone 07 — and e-mail (SMTP) in
Keycloak so people can verify addresses and reset passwords themselves. The sections below describe that setup.

## 1. Run Keycloak

Use a current Keycloak 26 release behind HTTPS (for example `quay.io/keycloak/keycloak:26.6.2` in production mode
with a PostgreSQL database and a reverse proxy holding the TLS certificate). Keep it patched; CI tests against the
version pinned in `.github/workflows/ci.yml`.

## 2. Create a realm and the desktop client

1. Create a realm, for example `project-browser`. The issuer becomes `https://<keycloak-host>/realms/project-browser`.
2. Realm settings → Login: turn on **Verify email** (people must verify their address before they can create or join
   organizations) and set up **Email** (SMTP) so verification messages can be sent. Turn **User registration** on if
   people may create their own accounts.
3. Clients → Create client:
   - Client ID: `project-browser-desktop` (any value; it becomes `OIDC_CLIENT_ID`)
   - Client authentication: **off** (public client — the desktop cannot keep a secret)
   - Authentication flow: **Standard flow** only (no direct access grants, no implicit flow)
   - Valid redirect URIs: `projectbrowser://auth/callback` (exactly)
   - Advanced → **Proof Key for Code Exchange Code Challenge Method: S256**
4. Recommended: Authentication → Policies → require **OTP or WebAuthn** for everyone, or at least for owners and admins;
   set a password policy.

## 3. Configure the API

```
OIDC_ISSUER=https://<keycloak-host>/realms/project-browser
OIDC_CLIENT_ID=project-browser-desktop
SESSION_SIGNING_KEY=<P-256 private JWK from your secret manager>
SESSION_ISSUER=pb-api-prod
TRUST_PROXY_HOPS=1            # number of reverse proxies in front of the API
```

Create the signing key once, for example with Node:
`node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify({...j,kid:'pb-session-1'})))"`
and store the output only in the secret manager. To rotate: put the old public key (the JWK without `d`) in
`SESSION_PREVIOUS_PUBLIC_KEYS` (a JSON array) for at least 10 minutes after switching.

## 4. Connect the desktop

In Project Browser: Account → Organization server → enter the API address (https) → Save → **Sign in or create an
account**. The sign-in page opens in the default browser; afterwards the browser hands control back to Project
Browser.
