import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCache } from '../src/cache.js';
import { collectUsage, summarize } from '../src/collect.js';
import { DEFAULT_CONFIG } from '../src/config.js';
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

describe('collection aggregation', () => {
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
      warnings: ['live refresh failed'],
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
