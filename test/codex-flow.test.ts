import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAdapter, identityHash } from '../src/providers/codex.js';
import { ProcessTracker } from '../src/processes.js';
import type { AccountConfig } from '../src/types.js';

async function fakeCodex(mode: 'ok' | 'mismatch' | 'malformed' | 'hang' = 'ok'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'));
  const path = join(dir, 'codex');
  const email = mode === 'mismatch' ? 'other@example.com' : 'user@example.com';
  const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.150.1'); process.exit(0); }
const readline = require('node:readline').createInterface({input:process.stdin});
readline.on('line', line => {
  if (${JSON.stringify(mode)} === 'hang') return;
  if (${JSON.stringify(mode)} === 'malformed') { console.log('not-json'); return; }
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({id:message.id,result:{userAgent:'fake'}}));
  if (message.method === 'account/read') console.log(JSON.stringify({id:message.id,result:{account:{type:'chatgpt',email:${JSON.stringify(email)},planType:'plus'},requiresOpenaiAuth:true}}));
  if (message.method === 'account/rateLimits/read') console.log(JSON.stringify({id:message.id,result:{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1787875200},secondary:null,rateLimitReachedType:null}}}}));
});`;
  await writeFile(path, script);
  await chmod(path, 0o700);
  return path;
}

function account(): AccountConfig {
  return {
    provider: 'codex',
    label: 'personal',
    stateDir: '/tmp/fake-home',
    ownership: 'external',
    identityHash: identityHash('user@example.com'),
  };
}

describe('Codex JSON-RPC flow', () => {
  it('performs handshake, identity check, and rate-limit collection', async () => {
    const tracker = new ProcessTracker();
    const adapter = new CodexAdapter(await fakeCodex(), tracker);
    const result = await adapter.collect(account(), {
      timeoutMs: 2_000,
      now: new Date('2026-08-27T18:00:00Z'),
    });
    expect(result).toMatchObject({
      provider: 'codex',
      label: 'personal',
      plan: 'plus',
      status: 'live',
    });
    expect(result.windows[0]).toMatchObject({ usedPercent: 25 });
    expect(tracker.size).toBe(0);
  });

  it('reads identity without requesting quota', async () => {
    const tracker = new ProcessTracker();
    const adapter = new CodexAdapter(await fakeCodex(), tracker);
    await expect(
      adapter.readIdentity(
        { ...account(), identityHash: undefined } as unknown as AccountConfig,
        2_000,
      ),
    ).resolves.toMatchObject({ email: 'user@example.com' });
  });

  it('refuses identity mismatch without retrying', async () => {
    const tracker = new ProcessTracker();
    const adapter = new CodexAdapter(await fakeCodex('mismatch'), tracker);
    await expect(adapter.collect(account(), { timeoutMs: 2_000 })).rejects.toMatchObject({
      data: { code: 'identity_mismatch' },
    });
    expect(tracker.size).toBe(0);
  });

  it('classifies malformed protocol and timeout and cleans children', async () => {
    const malformedTracker = new ProcessTracker();
    await expect(
      new CodexAdapter(await fakeCodex('malformed'), malformedTracker).collect(account(), {
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ data: { code: 'parse_failure' } });
    expect(malformedTracker.size).toBe(0);
    const hangTracker = new ProcessTracker();
    await expect(
      new CodexAdapter(await fakeCodex('hang'), hangTracker).collect(account(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ data: { code: 'timeout' } });
    expect(hangTracker.size).toBe(0);
  });
});
