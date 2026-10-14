# Security policy

## Reporting a vulnerability
Email **official.bibekthapa@gmail.com** with "SECURITY" in the subject. Please include:
- what is affected (desktop app version and OS, API endpoint, support console, release or update files);
- steps to reproduce, and what an attacker gains;
- whether you believe it is being exploited.

Please do not open a public issue for a vulnerability. If you prefer, use GitHub's private vulnerability
reporting (*Security → Report a vulnerability*) on this repository.

We aim to acknowledge reports within **3 business days** and to give an initial assessment within **10 business
days**. We will tell you when a fix is released and credit you if you wish.

## Please
- Test only against your own installation or accounts, never against other people's data or organizations.
- Do not degrade the service (no denial of service or mass automated scanning of the hosted service).
- Give us reasonable time to fix the issue before disclosing it.

## Supported versions
Security fixes go into the newest release on the `stable` channel. Older versions may be withdrawn. When that
happens, the app says that it must be updated.

## Verifying releases
Every desktop release is signed with the project's release key, and every published release carries a GitHub build
provenance attestation and an SBOM:
```bash
gh attestation verify <installer> --repo bibekthapamgr/antibrowser
```
The app itself verifies every update before installing it. Details are in
[docs/security/update-runbook.md](docs/security/update-runbook.md).

## More
- Threat model: [docs/security/threat-model.md](docs/security/threat-model.md)
- What the product does not protect against, and data retention:
  [docs/security/limitations.md](docs/security/limitations.md)
- Findings from security reviews: [docs/security/findings.md](docs/security/findings.md)
