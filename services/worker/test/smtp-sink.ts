/**
 * A minimal SMTP receiver for tests and CI (R2): accepts every message on 127.0.0.1 (no TLS, no auth) and keeps it in
 * memory and, when a directory is given, as `<n>.eml` files. Recipients containing "reject" are refused with 550, so
 * permanent failures can be tested. Never for production.
 *
 *   node services/worker/test/smtp-sink.ts --port 2525 --dir /tmp/mail   (CI: Keycloak and the worker send here)
 *   import { startSmtpSink } from '.../smtp-sink.ts'             (tests)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

export interface SinkMessage {
  from: string;
  to: string[];
  data: string;
}

export interface SmtpSink {
  port: number;
  messages: SinkMessage[];
  close(): Promise<void>;
}

export async function startSmtpSink(port = 0, dir: string | null = null): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  if (dir) mkdirSync(dir, { recursive: true });
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let current: SinkMessage = { from: '', to: [], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 sink.test ESMTP test sink');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          // Undo dot-stuffing.
          current.data = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          if (dir) writeFileSync(join(dir, `${messages.length}.eml`), current.data);
          current = { from: '', to: [], data: '' };
          reply('250 2.0.0 queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250-sink.test\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n');
        } else if (verb === 'HELO') reply('250 sink.test');
        else if (verb === 'MAIL') {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (to.includes('reject')) reply('550 5.1.1 no such mailbox');
          else {
            current.to.push(to);
            reply('250 2.1.5 ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 end with <CRLF>.<CRLF>');
        } else if (verb === 'RSET') {
          current = { from: '', to: [], data: '' };
          reply('250 ok');
        } else if (verb === 'NOOP') reply('250 ok');
        else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
          return;
        } else reply('502 5.5.2 not implemented');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    messages,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Run as a program (CI): node smtp-sink.ts --port 2525 --dir /tmp/mail
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const sink = await startSmtpSink(Number(arg('--port') ?? '2525'), arg('--dir') ?? null);
  console.log(`smtp sink on 127.0.0.1:${sink.port}`);
}
