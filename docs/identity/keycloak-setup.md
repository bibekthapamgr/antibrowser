# Setting up the identity provider (Keycloak)

Project Browser signs people in with standard OpenID Connect. Keycloak is the reference provider (ADR-0013): it is
free, open source and can run on your own server. A managed provider works too if it supports a public client with
PKCE, a `projectbrowser://auth/callback` redirect, `nonce`, `email_verified` and `auth_time`.

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
