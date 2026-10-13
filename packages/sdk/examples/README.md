# Project Browser SDK examples

TypeScript, run directly with Node 24 (`node examples/<file>.ts`). Configuration comes from environment variables;
nothing is written except screenshots you download.

| Example | What it shows |
|---|---|
| [run-workflow.ts](run-workflow.ts) | A job with steps (open an approved address, wait for a condition, screenshot), an Idempotency-Key kept with your record, waiting, outcomes and reconciliation, downloading screenshots |
| [webhook-receiver.ts](webhook-receiver.ts) | Verifying signatures, deduplicating on `webhook-id`, answering quickly |
| [playwright-debug.ts](playwright-debug.ts) | A debugging session: capability digest, waiting for the endpoint, `connectOverCDP` on the computer running the job, stopping the job |

API reference: [docs/automation/api.md](../../../docs/automation/api.md) and [docs/openapi.json](../../../docs/openapi.json).
