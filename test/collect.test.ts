import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCache } from '../src/cache.js';
import { collectUsage, summarize } from '../src/collect.js';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js';
import { discoverAccounts } from '../src/discovery.js';
import { renderHuman } from '../src/render-human.js';
import { appPaths } from '../src/paths.js';
import { identityHash } from '../src/providers/codex.js';
import type { AccountResult, UsageConfig } from '../src/types.js';

async function failingCodex(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'failing-codex-'));
  const file = join(dir, 'codex');
  await writeFile(
    file,
    `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('codex-cli 0.150.1');process.exit()}process.exit(1)`,
  );
  await chmod(file, 0o700);
  return file;
}

async function workingClaude(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'working-claude-'));
  const file = join(dir, 'claude');
  await writeFile(
    file,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('2.1.250 (Claude Code)');
  process.exit(0);
}
console.log(JSON.stringify({
  is_error: false,
  result: 'Current session: 12% used · resets Sep 2 at 1:40am (UTC)\\nCurrent week (all models): 34% used · resets Sep 8 at 3am (UTC)'
}));
`,
  );
  await chmod(file, 0o700);
  return file;
}

describe('collection aggregation', () => {
  it('collects Claude live in default mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'collect-live-claude-'));
    const paths = appPaths(home);
    const config: UsageConfig = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, claudeExecutable: await workingClaude() },
      accounts: [
        {
          provider: 'claude',
          label: 'personal',
          stateDir: join(home, '.claude'),
          ownership: 'external',
          claudeDefault: true,
        },
      ],
    };
    const summary = await collectUsage({
      config,
      selectors: [],
      mode: 'default',
      paths,
      now: new Date('2026-09-01T19:00:00Z'),
    });
    expect(summary).toMatchObject({
      exitCode: 0,
      results: [{ provider: 'claude', source: 'claude-cli', status: 'live' }],
    });
  });

  it('uses cache only without resolving or starting vendors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'collect-'));
    const paths = appPaths(home);
    const cached: AccountResult = {
      provider: 'claude',
      label: 'work',
      source: 'claude-statusline',
      status: 'cached',
      collectedAt: '2026-08-27T18:00:00Z',
      windows: [
        { id: 'five_hour', usedPercent: 1, remainingPercent: 99, resetAt: '2026-08-28T00:00:00Z' },
      ],
    };
    await writeCache(paths, cached);
    const config: UsageConfig = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, claudeExecutable: '/definitely/missing' },
      accounts: [
        { provider: 'claude', label: 'work', stateDir: '/tmp/no-read', ownership: 'external' },
      ],
    };
    const summary = await collectUsage({
      config,
      selectors: [],
      mode: 'cached',
      paths,
      now: new Date('2026-08-27T18:01:00Z'),
    });
    expect(summary).toMatchObject({ exitCode: 0, results: [{ status: 'cached' }] });
  });

  it('preserves cache after live failure and returns partial status', async () => {
    const home = await mkdtemp(join(tmpdir(), 'collect-'));
    const paths = appPaths(home);
    await writeCache(paths, {
      provider: 'codex',
      label: 'personal',
      source: 'codex-app-server',
      status: 'live',
      collectedAt: '2026-08-27T18:00:00Z',
      windows: [
        { id: 'five', usedPercent: 2, remainingPercent: 98, resetAt: '2026-08-28T00:00:00Z' },
      ],
    });
    const config: UsageConfig = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: await failingCodex() },
      accounts: [
        {
          provider: 'codex',
          label: 'personal',
          stateDir: '/tmp/fake',
          ownership: 'external',
          identityHash: identityHash('user@example.com'),
        },
      ],
    };
    const summary = await collectUsage({
      config,
      selectors: [],
      mode: 'default',
      paths,
      now: new Date('2026-08-27T18:01:00Z'),
    });
    expect(summary.exitCode).toBe(1);
    expect(summary.results[0]).toMatchObject({
      status: 'cached',
      warnings: ['live refresh failed: Codex app-server exited unexpectedly'],
    });
    expect(summary.errors[0]?.code).toBe('provider_failure');
  });

  it('aggregates exit codes independently of high usage', () => {
    const high: AccountResult = {
      provider: 'codex',
      label: 'x',
      source: 'test',
      status: 'live',
      collectedAt: new Date().toISOString(),
      windows: [{ id: 'x', usedPercent: 100, remainingPercent: 0, reached: true }],
    };
    expect(summarize([high], []).exitCode).toBe(0);
    expect(summarize([high], [{ code: 'timeout', message: 'x', retryable: false }]).exitCode).toBe(
      1,
    );
    expect(
      summarize(
        [{ ...high, status: 'unavailable' }],
        [{ code: 'timeout', message: 'x', retryable: false }],
      ).exitCode,
    ).toBe(2);
  });
});

describe('discovered subscriptions', () => {
  it('keeps logged-out Codex and Claude directories beside successful accounts, and refreshes the inventory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'collect-discovered-'));
    const paths = appPaths(home);
    for (const name of ['.codex-good', '.codex-off', '.claude-off']) await mkdir(join(home, name));
    const codex = join(home, 'fake-codex');
    const claude = join(home, 'fake-claude');
    await writeFile(
      codex,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.150.1'); process.exit(0); }
const off = process.env.CODEX_HOME.endsWith('-off');
const lines = require('node:readline').createInterface({input:process.stdin});
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') console.log(JSON.stringify({id:m.id,result:{}}));
  if (m.method === 'account/read') console.log(JSON.stringify({id:m.id,result:{account:off ? null : {type:'chatgpt',planType:'prolite'}}}));
  if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:42}}}}));
});`,
    );
    await writeFile(
      claude,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2.1.250 (Claude Code)'); process.exit(0); }
console.log(JSON.stringify({is_error:true,result:'Not logged in. Please run /login'}));`,
    );
    await chmod(codex, 0o700);
    await chmod(claude, 0o700);
    const request = {
      config: {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: codex, claudeExecutable: claude },
      },
      selectors: [],
      mode: 'default' as const,
      paths,
    };
    const summary = await collectUsage(request);
    expect(summary.exitCode).toBe(1);
    expect(summary.results).toMatchObject([
      {
        provider: 'claude',
        label: 'off',
        status: 'unavailable',
        error: { code: 'logged_out_account' },
      },
      { provider: 'codex', label: 'good', status: 'live', plan: 'prolite' },
      {
        provider: 'codex',
        label: 'off',
        status: 'unavailable',
        error: { code: 'logged_out_account' },
      },
    ]);
    const text = renderHuman(summary.results, summary.errors, { color: 'never' });
    expect(text).toContain('.claude-off auth failed');
    expect(text).toContain('.codex-off auth failed');
    expect(text).toContain('Login needed.');
    expect(summary.errors).toHaveLength(2);
    const selected = await collectUsage({ ...request, selectors: ['codex:good'] });
    expect(selected.exitCode).toBe(0);
    expect(selected.results).toHaveLength(1);
    await rm(join(home, '.codex-off'), { recursive: true });
    await mkdir(join(home, '.codex-new'));
    const next = await collectUsage(request);
    expect(
      next.results.filter((result) => result.provider === 'codex').map((result) => result.label),
    ).toEqual(['good', 'new']);
    expect((await collectUsage({ ...request, discover: false })).results).toEqual([]);
    expect(await new ConfigStore(paths).exists()).toBe(false);
  });

  it('discovers in cached mode without invoking vendors and never inherits a label-only cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'discovered-cache-'));
    const paths = appPaths(home);
    await mkdir(join(home, '.codex-work'));
    const fixture: AccountResult = {
      provider: 'codex',
      label: 'work',
      source: 'fixture',
      status: 'live',
      collectedAt: '2026-09-06T10:00:00Z',
      windows: [{ id: '5h', usedPercent: 5, remainingPercent: 95 }],
    };
    await writeCache(paths, fixture);
    const request = {
      config: {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: '/never-run-this' },
      },
      selectors: [],
      mode: 'cached' as const,
      paths,
      now: new Date('2026-09-06T10:01:00Z'),
    };
    expect((await collectUsage(request)).results[0]?.error?.code).toBe('missing_cache');
    const inventory = await discoverAccounts([], home);
    await writeCache(paths, fixture, inventory.accounts[0]?.discoveryKey);
    expect((await collectUsage(request)).results[0]).toMatchObject({
      label: 'work',
      status: 'cached',
    });
    await rename(join(home, '.codex-work'), join(home, 'old'));
    await mkdir(join(home, '.codex-work'));
    expect((await collectUsage(request)).results[0]?.error?.code).toBe('missing_cache');
  });
});
