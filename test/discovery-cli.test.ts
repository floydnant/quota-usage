import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function run(home: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ['dist/cli.js', ...args],
      {
        // Isolate the CLI's home lookup; cached/list commands must never start vendors.
        env: { ...process.env, HOME: home },
        timeout: 5_000,
      },
      (error, stdout, stderr) =>
        resolve({
          code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
          stdout,
          stderr,
        }),
    );
  });
}

describe('discovery CLI without registration', () => {
  it('lists directories and emits one cached JSON snapshot, with an opt-out', async () => {
    const home = await mkdtemp(join(tmpdir(), 'discovery-cli-'));
    await mkdir(join(home, '.codex-work'));
    await mkdir(join(home, '.codex'));
    await mkdir(join(home, '.claude-personal'));
    const listed = await run(home, ['accounts', 'list', '--verbose']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('.codex-work  auto-detected');
    expect(listed.stdout).toContain('.codex  auto-detected');
    expect(listed.stdout).toContain('.claude-personal  auto-detected');
    expect(listed.stdout).toContain('.codex-work');
    const cached = await run(home, ['--cached', '--json']);
    expect(cached.code).toBe(2);
    expect(cached.stderr).toBe('');
    expect(JSON.parse(cached.stdout)).toMatchObject({
      schemaVersion: 1,
      mode: 'cached',
      results: [
        {
          provider: 'claude',
          label: 'personal',
          status: 'unavailable',
          error: { code: 'missing_cache' },
        },
        {
          provider: 'codex',
          label: 'default',
          directoryName: '.codex',
          status: 'unavailable',
          error: { code: 'missing_cache' },
        },
        {
          provider: 'codex',
          label: 'work',
          status: 'unavailable',
          error: { code: 'missing_cache' },
        },
      ],
    });
    for (const selector of ['.codex', 'codex:default']) {
      const selected = await run(home, [selector, '--cached', '--json']);
      const document = JSON.parse(selected.stdout) as { results: Array<{ directoryName: string }> };
      expect(document.results.map((result) => result.directoryName)).toEqual(['.codex']);
    }
    const personal = await run(home, ['codex:personal', '--cached', '--json']);
    expect(personal.code).toBe(2);
    expect(JSON.parse(personal.stdout)).toMatchObject({
      results: [],
      errors: [{ code: 'invalid_configuration', message: 'Unknown account: codex:personal' }],
    });
    const plain = await run(home, ['.codex', '--cached', '--plain']);
    expect(plain.stdout).toContain('.codex unavailable');
    expect(plain.stdout).not.toContain('codex:default unavailable');
    const disabled = await run(home, ['--no-discover', '--cached', '--json']);
    expect(disabled.code).toBe(0);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ results: [], errors: [] });
  });
});
