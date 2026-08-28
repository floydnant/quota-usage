#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface Args {
  label: string;
  cache: string;
  previousFile?: string;
}

function args(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error('Invalid collector arguments');
    values.set(key.slice(2), value);
  }
  const label = values.get('label');
  const cache = values.get('cache');
  if (!label || !cache) throw new Error('Collector requires --label and --cache');
  const previousFile = values.get('previous-file');
  return { label, cache, ...(previousFile ? { previousFile } : {}) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

function extract(
  input: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined {
  const limits = input.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return undefined;
  const windows: Record<string, unknown>[] = [];
  for (const [id, raw] of Object.entries(limits as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const used = value.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const reset = value.resets_at;
    const resetAt =
      typeof reset === 'number'
        ? new Date(reset * 1_000).toISOString()
        : typeof reset === 'string' && Number.isFinite(Date.parse(reset))
          ? new Date(reset).toISOString()
          : null;
    windows.push({
      id,
      label: id === 'five_hour' ? '5h' : id === 'seven_day' ? '7d' : id.replaceAll('_', ' '),
      usedPercent: used,
      remainingPercent: Math.min(100, Math.max(0, 100 - used)),
      resetOriginal: reset === undefined ? null : reset,
      resetAt,
      ...(id === 'five_hour' ? { durationSeconds: 18_000 } : {}),
      ...(id === 'seven_day' ? { durationSeconds: 604_800 } : {}),
      reached: used >= 100,
    });
  }
  if (!windows.length) return undefined;
  const timestamp =
    typeof input.collected_at === 'string'
      ? input.collected_at
      : typeof input.timestamp === 'string'
        ? input.timestamp
        : new Date().toISOString();
  return {
    provider: 'claude',
    label,
    source: 'claude-statusline',
    status: 'cached',
    collectedAt: new Date(timestamp).toISOString(),
    windows,
  };
}

async function lock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      return async () => rmdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Cache lock timed out');
}

async function writeNewest(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const unlock = await lock(`${path}.lock`);
  try {
    const existing = await readFile(path, 'utf8')
      .then((text) => JSON.parse(text) as { collectedAt?: string })
      .catch(() => undefined);
    if (
      existing?.collectedAt &&
      Date.parse(existing.collectedAt) > Date.parse(String(value.collectedAt))
    ) {
      return;
    }
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlock();
  }
}

async function chain(command: string, input: string): Promise<void> {
  const child = spawn('/bin/sh', ['-c', command], {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.end(input);
  child.stdout.pipe(process.stdout);
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const input = await readStdin();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    // Claude should always provide JSON. Preserve prior status-line behavior even if it does not.
  }
  const result = parsed ? extract(parsed, options.label) : undefined;
  if (result) await writeNewest(options.cache, result);
  if (options.previousFile) {
    const previous = await readFile(options.previousFile, 'utf8')
      .then((text) => JSON.parse(text) as { command?: string })
      .catch(() => undefined);
    if (previous?.command) await chain(previous.command, input);
  }
}

await main().catch(() => {
  process.exitCode = 0;
});
