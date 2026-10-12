/**
 * The IPC surface is declared in four places that must agree: the TypeScript contract (what the UI may call),
 * build.rs (which commands get ACL permissions), the capability file (which permissions the main window holds)
 * and the Rust handler list. A command missing from any of them is either unreachable or ungoverned.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMANDS, EVENTS } from '@pb/contracts/ipc';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../src-tauri');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const contract = Object.keys(COMMANDS).sort();

describe('IPC surface', () => {
  it('build.rs generates permissions for exactly the contract commands', () => {
    const block = read('build.rs').match(/const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? '';
    const names = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(contract);
  });

  it('the main window capability grants exactly those commands plus event listening', () => {
    const cap = JSON.parse(read('capabilities/default.json')) as {
      windows: string[];
      permissions: string[];
      remote?: unknown;
    };
    expect(cap.windows).toEqual(['main']);
    expect(cap.remote).toBeUndefined();
    const commands = cap.permissions
      .filter((p) => p.startsWith('allow-'))
      .map((p) => p.slice('allow-'.length).replaceAll('-', '_'))
      .sort();
    expect(commands).toEqual(contract);
    const others = cap.permissions.filter((p) => !p.startsWith('allow-')).sort();
    expect(others).toEqual(['core:event:allow-listen', 'core:event:allow-unlisten']);
  });

  it('the Rust handler registers every contract command and nothing else', () => {
    const lib = read('src/lib.rs');
    const handler = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
    const names = [...handler.matchAll(/commands::([a-z_]+)/g)].map((m) => m[1]).sort();
    expect(names).toEqual(contract);
  });

  it('declares the four UI events', () => {
    expect(Object.keys(EVENTS).sort()).toEqual([
      'deep-link',
      'operation',
      'profiles-changed',
      'quit-requested',
    ]);
  });
});

describe('window security configuration', () => {
  const conf = JSON.parse(read('tauri.conf.json')) as {
    app: { withGlobalTauri: boolean; security: { csp: string; freezePrototype: boolean } };
    plugins: Record<string, unknown>;
  };
  const csp = Object.fromEntries(
    conf.app.security.csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  ) as Record<string, string[]>;

  it('uses a restrictive CSP with no remote origins or eval', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(conf.app.security.csp).not.toMatch(/unsafe-eval|https?:\/\/(?!ipc\.localhost)/);
  });

  it('does not expose the Tauri global and freezes prototypes', () => {
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.security.freezePrototype).toBe(true);
  });

  it('registers only the projectbrowser deep-link scheme', () => {
    expect(conf.plugins['deep-link']).toEqual({ desktop: { schemes: ['projectbrowser'] } });
  });
});
