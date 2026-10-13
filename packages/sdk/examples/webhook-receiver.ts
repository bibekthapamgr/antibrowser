/**
 * A webhook receiver: verifies the signature, deduplicates on webhook-id, answers 2xx quickly.
 *
 *   PB_WEBHOOK_SECRET=whsec_… node examples/webhook-receiver.ts   (listens on :8787; put HTTPS in front of it)
 *
 * Retries and redeliveries carry the same webhook-id: process each id once. Answer within 10 s; do slow work later.
 */
import { createServer } from 'node:http';
import { parseWebhook, verifyWebhook } from '../src/index.ts';

const secret = process.env.PB_WEBHOOK_SECRET ?? '';
if (!secret.startsWith('whsec_')) throw new Error('PB_WEBHOOK_SECRET (whsec_…) is required');
/** Use your database in production (a unique key on webhook-id). */
const seen = new Set<string>();

createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c: string) => {
    body += c;
    if (body.length > 65_536) req.destroy();
  });
  req.on('end', async () => {
    if (!(await verifyWebhook(secret, req.headers, body))) {
      res.writeHead(401).end();
      return;
    }
    const id = String(req.headers['webhook-id']);
    if (seen.has(id)) {
      res.writeHead(204).end(); // already processed: a retry or a redelivery
      return;
    }
    seen.add(id);
    const event = parseWebhook<{ job_id?: string; state?: string; error_code?: string | null }>(body);
    console.log(event.type, event.data.job_id ?? '', event.data.state ?? '', event.data.error_code ?? '');
    res.writeHead(204).end();
  });
}).listen(8787, () => console.log('listening on :8787'));
