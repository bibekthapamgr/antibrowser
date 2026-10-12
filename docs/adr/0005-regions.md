# 0005 — Regions
Status: **Proposed**. Date: 2026-10-12. Owner: product owner + operations.

## Context
Roadmap: one primary backend region with multi-zone managed services; RPO <= 15 minutes and RTO <= 4 hours for metadata, demonstrated by restore drill. Browser CPU/RAM stays on customer devices, so the region mainly affects API latency (target p95 <= 250 ms inside the region), data residency and cost.

## Proposed decision
- One primary region, chosen by where pilot customers are and their data-residency needs; managed PostgreSQL (multi-zone, point-in-time recovery), object storage in the same region, CDN for signed downloads.
- Backups: continuous WAL archiving to a **second region** (copy only, no active traffic) so the RPO/RTO objective survives a regional outage.
- Staging lives in the same region as prod, in a separate account/project.
- The region is recorded per organization from day one (`organizations` can gain a `region` column) so a second region can be added without migrating every tenant.

## Open input needed
Expected customer locations and any EU/UK data-residency requirements. Until then, no region-specific code is written.
