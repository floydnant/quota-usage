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
  directKill: 'real',
  children: [] as ChildProcess[],
  unrefed: new Set<number>(),
  treeKillCalls: 0,
}));

vi.mock('../src/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform.js')>();
  return {
    ...actual,
    isWindows: true,
    killOwnedTree: vi.fn(async (): Promise<void> => undefined),
    killWindowsTree: vi.fn(async (): Promise<void> => {
      platform.treeKillCalls += 1;
      if (platform.treeKill === 'fail') throw new Error('taskkill failed');
    }),
    spawnExecutable: (...args: Parameters<typeof actual.spawnExecutable>): ChildProcess => {
      const child = actual.spawnExecutable(...args);
      platform.children.push(child);
      // Records whether give-up paths actually unref the child they abandon.
      const unref = child.unref.bind(child);
      child.unref = (): void => {
        if (child.pid !== undefined) platform.unrefed.add(child.pid);
        unref();
      };
      // Simulates a child that also survives the direct kill, silently or with
      // the 'error' event Node emits when a signal cannot be delivered.
      if (platform.directKill !== 'real')
        child.kill = () => {
          if (platform.directKill === 'error') child.emit('error', new Error('kill EPERM'));
          return false;
        };
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
    platform.directKill = 'real';
    platform.unrefed.clear();
    platform.treeKillCalls = 0;
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
      expect(child.pid).toBeDefined();
      controller.abort();
      const elapsed = timed(run);
      await expect(run).rejects.toMatchObject({ failure: 'cancelled' });
      expect(await elapsed).toBeLessThan(SETTLE_BOUND_MS);
      expect(isAlive(child.pid as number)).toBe(false);
      // The direct kill actually ended the child, so give-up and release did not run.
      expect(platform.unrefed.has(child.pid as number)).toBe(false);
    },
  );

  it('settles a timed out update command when the tree kill is a no-op', async () => {
    const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 300);
    const elapsed = timed(run);
    await expect(run).rejects.toMatchObject({ failure: 'timeout' });
    expect(await elapsed).toBeLessThan(300 + SETTLE_BOUND_MS);
  });

  it.each([
    { directKill: 'ignore' as const, bound: SETTLE_BOUND_MS },
    // The 'error' path settles via the child.on('error') handler right after
    // the first grace, not via boundExit's second grace, so it must stay inside
    // ~300 ms escalation + one KILL_EXIT_GRACE_MS; regressing into the slower
    // give-up path makes this bound trip.
    { directKill: 'error' as const, bound: 300 + KILL_EXIT_GRACE_MS + 1_000 },
  ])(
    'settles a cancelled update command when the direct kill is $directKill',
    async ({ directKill, bound }) => {
      platform.directKill = directKill;
      const controller = new AbortController();
      const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 30_000, controller.signal);
      await expect.poll(() => platform.children[0]?.pid).toBeDefined();
      const child = platform.children[0] as ChildProcess;
      expect(child.pid).toBeDefined();
      controller.abort();
      const elapsed = timed(run);
      await expect(run).rejects.toMatchObject({ failure: 'cancelled' });
      expect(await elapsed).toBeLessThan(bound);
      // The command gave up on the child; teardown ends it.
      expect(isAlive(child.pid as number)).toBe(true);
      // Give-up releases the child's pipe and handle so neither keeps the CLI
      // open; the 'error' direct kill path short-circuits the promise before
      // boundExit's second grace completes, so poll until release has happened.
      await expect.poll(() => child.stdout?.destroyed, { timeout: SETTLE_BOUND_MS }).toBe(true);
      expect(platform.unrefed.has(child.pid as number)).toBe(true);
    },
  );

  it('classifies a spawn ENOENT as worker even when the signal aborts in the same tick', async () => {
    const controller = new AbortController();
    const run = runUpdateCommand('does-not-exist', [], tmpdir(), 1_000, controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({ failure: 'worker' });
  });

  it('does not start a third tree kill after boundExit gives up', async () => {
    platform.directKill = 'ignore';
    const controller = new AbortController();
    const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 30_000, controller.signal);
    await expect.poll(() => platform.children[0]?.pid).toBeDefined();
    controller.abort();
    await expect(run).rejects.toMatchObject({ failure: 'cancelled' });
    // SIGTERM and SIGKILL tree kills ran from terminate() and its escalation;
    // boundExit's final give-up must not start a third one via cleanup().
    expect(platform.treeKillCalls).toBe(2);
  });

  it('returns from ProcessTracker.cleanup when the tracked child does not exit', async () => {
    const child = spawn(process.execPath, IDLE, { stdio: 'ignore' });
    spawned.push(child);
    const unrefSpy = vi.spyOn(child, 'unref');
    const tracker = new ProcessTracker();
    tracker.track(childOwned(child));
    expect(await timed(tracker.cleanup(20))).toBeLessThan(20 + KILL_EXIT_GRACE_MS + 2_000);
    expect(tracker.size).toBe(0);
    expect(child.pid).toBeDefined();
    expect(isAlive(child.pid as number)).toBe(true);
    // Give-up released the abandoned child so it cannot hold the CLI event loop open.
    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a timed out runProcess when the tracked child does not exit', async () => {
    const tracker = new ProcessTracker();
    const run = runProcess(process.execPath, IDLE, { timeoutMs: 100, tracker });
    const elapsed = timed(run);
    await expect(run).rejects.toMatchObject({ data: { code: 'timeout' } });
    expect(await elapsed).toBeLessThan(100 + KILL_EXIT_GRACE_MS + 2_000);
    // Give-up released the abandoned child so it cannot hold the CLI event loop open.
    const child = platform.children[0] as ChildProcess;
    expect(child.pid).toBeDefined();
    expect(child.stdin?.destroyed).toBe(true);
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    expect(platform.unrefed.has(child.pid as number)).toBe(true);
  });
});
