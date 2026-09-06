import { chmod, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UsageError } from './errors.js';
import { ensurePrivateDir, type AppPaths } from './paths.js';
import type { AccountResult, Provider } from './types.js';

export function cachePath(
  paths: AppPaths,
  provider: Provider,
  label: string,
  discoveryKey?: string,
): string {
  return join(paths.cacheDir, `${provider}-${label}${discoveryKey ? `-${discoveryKey}` : ''}.json`);
}

export function withFreshness(
  result: AccountResult,
  now: Date,
  staleAfterMs: number,
): AccountResult {
  const collected = Date.parse(result.collectedAt);
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - collected) / 1_000));
  const resets = result.windows
    .map((window) => (window.resetAt ? Date.parse(window.resetAt) : Number.NaN))
    .filter(Number.isFinite);
  const expired = resets.length > 0 && resets.every((reset) => reset <= now.getTime());
  return {
    ...result,
    source: result.source,
    status: expired ? 'expired' : ageSeconds * 1_000 > staleAfterMs ? 'stale' : 'cached',
    cacheAgeSeconds: ageSeconds,
  };
}

export async function readCache(
  paths: AppPaths,
  provider: Provider,
  label: string,
  now: Date,
  staleAfterMs: number,
  discoveryKey?: string,
): Promise<AccountResult> {
  const path = cachePath(paths, provider, label, discoveryKey);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new UsageError('missing_cache', `No cached reading for ${provider}:${label}`, {
      provider,
      accountLabel: label,
      cause: error,
    });
  }
  try {
    const parsed = JSON.parse(raw) as AccountResult;
    if (parsed.provider !== provider || parsed.label !== label || !Array.isArray(parsed.windows)) {
      throw new Error('cache identity does not match');
    }
    return withFreshness(parsed, now, staleAfterMs);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError('parse_failure', `Invalid cache for ${provider}:${label}`, {
      provider,
      accountLabel: label,
      cause: error,
    });
  }
}

export async function writeCache(
  paths: AppPaths,
  result: AccountResult,
  discoveryKey?: string,
): Promise<boolean> {
  await ensurePrivateDir(paths.cacheDir);
  const path = cachePath(paths, result.provider, result.label, discoveryKey);
  const existing = await readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as AccountResult)
    .catch(() => undefined);
  if (existing && Date.parse(existing.collectedAt) > Date.parse(result.collectedAt)) return false;
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(result)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
  return true;
}
