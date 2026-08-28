import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('packed npm artifact', () => {
  it('contains only intended files and executes its installed usage binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-pack-'));
    const packed = await execute('npm', ['pack', '--json', '--pack-destination', root], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const metadata = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const artifact = metadata[0];
    expect(artifact).toBeDefined();
    if (!artifact) throw new Error('npm pack returned no artifact metadata');
    const files = artifact.files.map((file) => file.path);
    expect(files).toContain('package.json');
    expect(files).toContain('README.md');
    expect(files).toContain('LICENSE');
    expect(files.some((file) => file === 'dist/cli.js')).toBe(true);
    expect(
      files.every((file) => /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/.test(file)),
    ).toBe(true);

    const prefix = join(root, 'install');
    await execute(
      'npm',
      [
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--omit=dev',
        join(root, artifact.filename),
      ],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const help = await execute(join(prefix, 'node_modules', '.bin', 'usage'), ['--help'], {
      timeout: 5_000,
    });
    expect(help.stdout).toContain('Report Codex and Claude Code subscription quota usage');
    expect(help.stdout).toContain('accounts');
    expect(help.stdout).toContain('doctor');
  }, 60_000);
});
