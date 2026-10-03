import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitsWithin, KILL_EXIT_GRACE_MS, killOwnedTree, settlesWithin } from '../src/platform.js';
import { isAlive } from './process-tree.js';

// taskkill cannot start; every other spawn is real. A Windows tree kill then
// fails, and killOwnedTree must fall back to killing the child directly.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command: string, ...rest: unknown[]) => {
      if (command === 'taskkill') throw new Error('taskkill unavailable');
      return (actual.spawn as (...args: unknown[]) => ChildProcess)(command, ...rest);
    }),
  };
});

const IDLE = ['-e', 'setInterval(()=>{},1000)'];

describe('bounded waits on killed children', () => {
  const children: ChildProcess[] = [];
  const idle = (): ChildProcess => {
    const child = spawn(process.execPath, IDLE, { stdio: 'ignore' });
    children.push(child);
    return child;
  };

  afterEach(async () => {
    for (const child of children.splice(0)) {
      const pid = child.pid;
      if (pid === undefined || !isAlive(pid)) continue;
      process.kill(pid, 'SIGKILL');
      await expect.poll(() => isAlive(pid), { timeout: 5_000 }).toBe(false);
    }
  });

  it('reports whether a promise settled within the limit', async () => {
    await expect(settlesWithin(Promise.resolve(), 1_000)).resolves.toBe(true);
    await expect(settlesWithin(Promise.reject(new Error('failed')), 1_000)).resolves.toBe(true);
    await expect(settlesWithin(new Promise(() => undefined), 20)).resolves.toBe(false);
  });

  it('reports whether a child exited within the limit', async () => {
    const child = idle();
    await expect(exitsWithin(child, 20)).resolves.toBe(false);
    expect(child.listenerCount('exit')).toBe(0);
    child.kill('SIGKILL');
    await expect(exitsWithin(child, 5_000)).resolves.toBe(true);
    await expect(exitsWithin(child, 20)).resolves.toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'kills the child directly when the Windows tree kill fails',
    async () => {
      const child = idle();
      const started = Date.now();
      await killOwnedTree(child, 'SIGKILL');
      expect(Date.now() - started).toBeLessThan(KILL_EXIT_GRACE_MS + 2_000);
      await expect(exitsWithin(child, 5_000)).resolves.toBe(true);
    },
  );
});
