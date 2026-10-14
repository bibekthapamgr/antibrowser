# Cost worksheet (milestone 11)

[`cost-worksheet.csv`](cost-worksheet.csv) is a spreadsheet template (formulas included; open it in Excel, Numbers,
LibreOffice or Google Sheets). It contains **no prices and no provider rates**: the owner fills them in from the real
price lists and invoices, and pilot usage from the ledger. The plan limits in it are the catalog's provisional values.

What it answers, per plan: the monthly cost of one organization (storage, downloads, payment processing, support, a
share of the fixed costs), the margin at the price you choose, and the break-even price.

What costs what (ADR-0018 and the roadmap):
- **Browser CPU and memory run on the customer's computers**: no provider cost, so plans are not sized by compute.
- **Cloud backup storage and downloads** are provider costs: storage per GB-month for what organizations keep, egress
  for restores and new computers. The plan's storage allowance caps the first; downloads are not capped.
- **Payment processing**: Stripe's per-charge percentage and fixed fee for Ten Tech Solutions LLC's account, Stripe
  Billing's fee if the account's plan charges one, and Stripe Tax per charge if tax calculation is switched on.
- **Support** time per organization, and **fixed costs** (servers, managed database, identity provider, monitoring,
  e-mail, domains, code-signing certificates) shared over the paying organizations.
- Remote browsers (hosted browsing) would be a separate per-minute product with its own worksheet; not offered.

## Inputs from the pilot

The usage ledger has the numbers the worksheet asks for. On the test server (read-only queries):

```bash
cd /tmp && runuser -u postgres -- /usr/pgsql-18/bin/psql pb_dev   # AlmaLinux (PGDG); Debian/Ubuntu: psql
```

```sql
-- Storage kept per organization now (bytes → GB), and as a fraction of its plan's allowance
select o.name, round(app.billing_storage_used(o.id) / 1e9, 2) as gb,
       round(app.billing_storage_used(o.id) / nullif((e.limits->>'storage_bytes')::numeric, 0), 2) as fraction
  from app.organizations o cross join app.billing_effective(o.id) e order by gb desc;

-- Committed backups and finished jobs per organization over the last 30 days
select org_id, type, count(*) as events,
       round(sum(quantity) / case when type = 'snapshot_committed' then 1e9 else 1 end, 2) as gb_or_jobs
  from app.usage_events
 where occurred_at > now() - interval '30 days' and type in ('snapshot_committed', 'automation_job')
 group by org_id, type order by org_id, type;

-- API-token requests per organization and day
select org_id, day, requests from app.api_usage_daily where day > current_date - 30 order by org_id, day;
```

Backup downloads are not in the ledger yet (restores are served by signed storage URLs); take them from the storage
provider's egress report until a metered unit exists.

## Turning the result into the catalog

1. Choose prices and limits per plan; check the margin with realistic usage, not the allowance.
2. Add a new catalog version with the final limits (`team@2` …) in `packages/contracts/src/billing.ts` — released
   versions never change ([billing README](README.md#plan-catalog)).
3. Create the Stripe prices with `stripe-setup.ts` (test mode) and later in live mode as a reviewed step.
