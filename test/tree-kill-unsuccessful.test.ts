import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KILL_EXIT_GRACE_MS } from '../src/platform.js';
import { childOwned, ProcessTracker, runProcess } from '../src/processes.js';
import { runUpdateCommand } from '../src/update-checkout.js';
import { isAlive } from './process-tree.js';

// The Windows tree kill is replaced by one that does nothing (or fails), so a
// real idle child outlives it on every platform. Cancellation, timeout, and
// cleanup must still settle within a bound instead of waiting on that child.
const platform = vi.hoisted(() => ({
  treeKill: 'noop',
  ignoreDirectKill: false,
  children: [] as ChildProcess[],
}));

vi.mock('../src/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform.js')>();
  return {
    ...actual,
    isWindows: true,
    killOwnedTree: vi.fn(async (): Promise<void> => undefined),
    killWindowsTree: vi.fn(async (): Promise<void> => {
      if (platform.treeKill === 'fail') throw new Error('taskkill failed');
    }),
    spawnExecutable: (...args: Parameters<typeof actual.spawnExecutable>): ChildProcess => {
      const child = actual.spawnExecutable(...args);
      platform.children.push(child);
      // Simulates a child that also survives the direct kill.
      if (platform.ignoreDirectKill) child.kill = () => false;
      return child;
    },
  };
});

const IDLE = ['-e', 'setInterval(()=>{},1000)'];
/** Escalation, two exit grace periods, and scheduling headroom. */
const SETTLE_BOUND_MS = 300 + 2 * KILL_EXIT_GRACE_MS + 2_000;

async function timed(promise: Promise<unknown>): Promise<number> {
  const started = Date.now();
  await promise.catch(() => undefined);
  return Date.now() - started;
}

describe('an unsuccessful tree kill never leaves shutdown waiting', () => {
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    platform.treeKill = 'noop';
    platform.ignoreDirectKill = false;
    for (const child of [...platform.children.splice(0), ...spawned.splice(0)]) {
      const pid = child.pid;
      if (pid === undefined || !isAlive(pid)) continue;
      process.kill(pid, 'SIGKILL');
      await expect.poll(() => isAlive(pid), { timeout: 5_000 }).toBe(false);
    }
  });

  it.each(['noop', 'fail'] as const)(
    'settles a cancelled update command when the tree kill is a %s, by killing the child directly',
    async (treeKill) => {
      platform.treeKill = treeKill;
      const controller = new AbortController();
      const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 30_000, controller.signal);
      await expect.poll(() => platform.children[0]?.pid).toBeDefined();
      const child = platform.children[0] as ChildProcess;
      controller.abort();
      const elapsed = timed(run);
      await expect(run).rejects.toMatchObject({ failure: 'cancelled' });
      expect(await elapsed).toBeLessThan(SETTLE_BOUND_MS);
      expect(isAlive(child.pid ?? 0)).toBe(false);
    },
  );

  it('settles a timed out update command when the tree kill is a no-op', async () => {
    const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 300);
    const elapsed = timed(run);
    await expect(run).rejects.toMatchObject({ failure: 'timeout' });
    expect(await elapsed).toBeLessThan(300 + SETTLE_BOUND_MS);
  });

  it('settles a cancelled update command even when the child survives every kill', async () => {
    platform.ignoreDirectKill = true;
    const controller = new AbortController();
    const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 30_000, controller.signal);
    await expect.poll(() => platform.children[0]?.pid).toBeDefined();
    const child = platform.children[0] as ChildProcess;
    controller.abort();
    const elapsed = timed(run);
    await expect(run).rejects.toMatchObject({ failure: 'cancelled' });
    expect(await elapsed).toBeLessThan(SETTLE_BOUND_MS);
    // The command gave up on the child; teardown ends it.
    expect(isAlive(child.pid ?? 0)).toBe(true);
  });

  it('returns from ProcessTracker.cleanup when the tracked child does not exit', async () => {
    const child = spawn(process.execPath, IDLE, { stdio: 'ignore' });
    spawned.push(child);
    const tracker = new ProcessTracker();
    tracker.track(childOwned(child));
    expect(await timed(tracker.cleanup(20))).toBeLessThan(20 + KILL_EXIT_GRACE_MS + 2_000);
    expect(tracker.size).toBe(0);
    expect(isAlive(child.pid ?? 0)).toBe(true);
  });

  it('rejects a timed out runProcess when the tracked child does not exit', async () => {
    const tracker = new ProcessTracker();
    const run = runProcess(process.execPath, IDLE, { timeoutMs: 100, tracker });
    const elapsed = timed(run);
    await expect(run).rejects.toMatchObject({ data: { code: 'timeout' } });
    expect(await elapsed).toBeLessThan(100 + KILL_EXIT_GRACE_MS + 2_000);
    await tracker.cleanup(20);
  });
});
