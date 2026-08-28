import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCache, withFreshness, writeCache } from '../src/cache.js';
import { appPaths } from '../src/paths.js';
import type { AccountResult } from '../src/types.js';

function result(
  collectedAt: string,
  resetAt: string | null = '2026-08-28T00:00:00.000Z',
): AccountResult {
  return {
    provider: 'claude',
    label: 'work',
    source: 'claude-statusline',
    status: 'cached',
    collectedAt,
    windows: [{ id: 'five_hour', usedPercent: 25, remainingPercent: 75, resetAt }],
  };
}

describe('cache', () => {
  it('classifies fresh, stale, expired, and unknown resets', () => {
    const now = new Date('2026-08-27T18:20:00.000Z');
    expect(withFreshness(result('2026-08-27T18:15:00.000Z'), now, 900_000).status).toBe('cached');
    expect(withFreshness(result('2026-08-27T17:00:00.000Z'), now, 900_000).status).toBe('stale');
    expect(
      withFreshness(result('2026-08-27T18:15:00.000Z', '2026-08-27T18:19:00.000Z'), now, 900_000)
        .status,
    ).toBe('expired');
    expect(withFreshness(result('2026-08-27T17:00:00.000Z', null), now, 900_000).status).toBe(
      'stale',
    );
  });

  it('atomically keeps the newest timestamp', async () => {
    const home = await mkdtemp(join(tmpdir(), 'quota-cache-'));
    const paths = appPaths(home);
    expect(await writeCache(paths, result('2026-08-27T18:10:00.000Z'))).toBe(true);
    expect(await writeCache(paths, result('2026-08-27T18:00:00.000Z'))).toBe(false);
    expect(
      (await readCache(paths, 'claude', 'work', new Date('2026-08-27T18:11:00.000Z'), 900_000))
        .collectedAt,
    ).toBe('2026-08-27T18:10:00.000Z');
    expect(
      JSON.parse(await readFile(join(paths.cacheDir, 'claude-work.json'), 'utf8')),
    ).toMatchObject({ label: 'work' });
  });

  it('distinguishes missing and invalid caches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'quota-cache-'));
    const paths = appPaths(home);
    await expect(readCache(paths, 'codex', 'x', new Date(), 1)).rejects.toMatchObject({
      data: { code: 'missing_cache' },
    });
  });
});
