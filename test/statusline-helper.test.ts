import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function runHelper(
  label: string,
  cache: string,
  input: string,
  previous?: string,
): Promise<{ stdout: string; code: number | null }> {
  const args = [resolve('dist/statusline-helper.js'), '--label', label, '--cache', cache];
  if (previous) args.push('--previous-file', previous);
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stdin.end(input);
  const code = await new Promise<number | null>((done) => child.once('exit', done));
  return { stdout, code };
}

describe('compiled Claude status-line helper', () => {
  it('extracts quota only and chains the exact same input to the previous command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'status-helper-'));
    const previous = join(dir, 'previous.json');
    const cache = join(dir, 'cache.json');
    await writeFile(previous, JSON.stringify({ command: '/bin/cat' }), { mode: 0o600 });
    const input = JSON.stringify({
      collected_at: '2026-08-27T18:00:00Z',
      prompt: 'must not persist',
      session_id: 'also-private',
      rate_limits: { five_hour: { used_percentage: 33.3, resets_at: 1787875200 } },
    });
    const result = await runHelper('work', cache, input, previous);
    expect(result).toEqual({ stdout: input, code: 0 });
    const stored = await readFile(cache, 'utf8');
    expect(JSON.parse(stored)).toMatchObject({
      provider: 'claude',
      label: 'work',
      windows: [{ usedPercent: 33.3 }],
    });
    expect(stored).not.toContain('must not persist');
    expect(stored).not.toContain('also-private');
  });

  it('rejects an older timestamp overwriting a newer cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'status-helper-'));
    const cache = join(dir, 'cache.json');
    const payload = (timestamp: string, used: number) =>
      JSON.stringify({
        collected_at: timestamp,
        rate_limits: { five_hour: { used_percentage: used } },
      });
    await runHelper('work', cache, payload('2026-08-27T19:00:00Z', 50));
    await runHelper('work', cache, payload('2026-08-27T18:00:00Z', 10));
    expect(JSON.parse(await readFile(cache, 'utf8'))).toMatchObject({
      collectedAt: '2026-08-27T19:00:00.000Z',
      windows: [{ usedPercent: 50 }],
    });
    await chmod(cache, 0o600);
  });
});
