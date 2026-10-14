# Fresh-user demo (no server commands after setup)

What a new customer and an invited teammate do on the test server, once the owner has given it a mail server.

## Once, by the owner (server)
1. Create `/etc/project-browser/smtp.env` with your mail provider's settings (format in
   [self-service.md](self-service.md#3-identity-settings-scriptsdeploykeycloak-setupsh-enforced-on-every-run)).
   With Gmail: turn on 2-step verification, create an "app password", use `SMTP_HOST=smtp.gmail.com`,
   `SMTP_PORT=587`, `SMTP_SECURITY=starttls`, `SMTP_USER` and `SMTP_FROM` = your Gmail address. Keep the file root-only:
   `chmod 600 /etc/project-browser/smtp.env`.
2. Update the server and re-run the identity setup:
   `\cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh` (twice), then
   `\cp -f /home/pb/antibrowser/scripts/deploy/keycloak-setup.sh /root/ && bash /root/keycloak-setup.sh`.
   It must report "self-registration on".
3. Open the tunnel on your computer (as before): `ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 -L 8333:127.0.0.1:8333 root@<server>`.

## A new customer (browser only)
1. Open `http://127.0.0.1:8080/app/` → **Create account**.
2. Fill in e-mail, name and password on the sign-in page → "verify your e-mail" → open the link in the e-mail.
3. Back in the portal: tick the terms (marketing e-mails optional) → **Create my workspace**.
4. "Welcome": the workspace has a 14-day trial; a welcome e-mail arrives; **Download** the app.

## The same customer in the desktop app
Account → server `http://127.0.0.1:8080` (preconfigured in builds made with `PB_DEFAULT_SERVER`) → **Sign in** →
the app opens Profiles in the same workspace. No question is asked again.

## An invited teammate
1. The customer (owner) invites `teammate@…` in the app (Organization → Invitations). The e-mail is sent
   automatically ("Invitation e-mailed").
2. The teammate opens the link → **Create account** with that address → verifies → **Accept and join**.
3. The teammate is in the customer's team only: no personal workspace, no trial, no payment.

## If something goes wrong
- "Sign-in did not complete": try again (links are single-use and expire after 10 minutes).
- No e-mail: `bash /root/keycloak-setup.sh email-status` (server) shows recent send results without addresses.
- "This invitation is for a different e-mail address": sign out in the portal and sign in with the invited address.
