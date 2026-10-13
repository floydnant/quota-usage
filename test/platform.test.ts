import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableCandidates, spawnExecutable } from '../src/platform.js';
import { writeFakeExecutable } from './fake-executable.js';

describe('platform process launching', () => {
  it('passes arguments through unchanged, including through a Windows .cmd shim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-platform-'));
    const executable = await writeFakeExecutable(
      join(dir, 'echo args'),
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
    );
    const args = ['plain', 'with space', 'a&b|c', '"quoted"', '100%', '^caret', 'trail\\', ''];
    const child = spawnExecutable(executable, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(args);
  });

  it('tries PATHEXT extensions only on Windows', () => {
    const candidates = executableCandidates(join('bin', 'codex'), { PATHEXT: '.EXE;.CMD' });
    if (process.platform === 'win32')
      expect(candidates).toEqual([join('bin', 'codex.exe'), join('bin', 'codex.cmd')]);
    else expect(candidates).toEqual([join('bin', 'codex')]);
  });
});
