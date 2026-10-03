import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KILL_EXIT_GRACE_MS } from '../src/platform.js';
import { childOwned, ProcessTracker, runProcess } from '../src/processes.js';
import { CodexAdapter, identityHash } from '../src/providers/codex.js';
import { runUpdateCommand } from '../src/update-checkout.js';
import type { AccountConfig } from '../src/types.js';
import { writeFakeExecutable } from './fake-executable.js';
import { isAlive } from './process-tree.js';

// A `.cmd` fake has a cmd.exe parent and a real Node grandchild; a plain
// SIGKILL to the recorded pid stops cmd.exe but leaves the grandchild running.
// On Windows every teardown kill therefore goes through `taskkill /T /F`.
function hardKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

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
      hardKill(pid);
      await expect.poll(() => isAlive(pid), { timeout: 5_000 }).toBe(false);
    }
  });

  it.each([
    { treeKill: 'noop' as const, title: 'does nothing' },
    // `killWindowsTree` is documented never to reject; this variant feeds it a
    // throwing fake so the defensive `.catch(() => undefined)` chain inside
    // `killOwnedTree` is exercised.
    { treeKill: 'fail' as const, title: 'violates its never-rejects contract' },
  ])(
    'settles a cancelled update command when the tree kill $title, by killing the child directly',
    async ({ treeKill }) => {
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

  it.each([
    { directKill: 'real' as const, aliveAfter: false, bound: 300 + SETTLE_BOUND_MS },
    { directKill: 'ignore' as const, aliveAfter: true, bound: 300 + SETTLE_BOUND_MS },
    { directKill: 'error' as const, aliveAfter: true, bound: 300 + KILL_EXIT_GRACE_MS + 1_000 },
  ])(
    'settles a timed out update command when the direct kill is $directKill',
    async ({ directKill, aliveAfter, bound }) => {
      platform.directKill = directKill;
      const run = runUpdateCommand(process.execPath, IDLE, tmpdir(), 300);
      await expect.poll(() => platform.children[0]?.pid).toBeDefined();
      const child = platform.children[0] as ChildProcess;
      expect(child.pid).toBeDefined();
      const elapsed = timed(run);
      await expect(run).rejects.toMatchObject({ failure: 'timeout' });
      expect(await elapsed).toBeLessThan(bound);
      expect(isAlive(child.pid as number)).toBe(aliveAfter);
    },
  );

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

  it('rejects a Codex collect when the app-server ignores SIGTERM and never answers', async () => {
    // A fake codex that answers --version but, in app-server mode, ignores
    // SIGTERM, never reads stdin, and never writes a response.
    const dir = await mkdtemp(join(tmpdir(), 'fake-codex-close-'));
    const path = join(dir, 'codex');
    const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.150.1'); process.exit(0); }
process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);`;
    const executable = await writeFakeExecutable(path, script);
    const tracker = new ProcessTracker();
    const adapter = new CodexAdapter(executable, tracker);
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir: tmpdir(),
      ownership: 'external',
      identityHash: identityHash('user@example.com'),
    };
    const started = Date.now();
    await expect(adapter.collect(account, { timeoutMs: 100 })).rejects.toMatchObject({
      data: { code: 'timeout' },
    });
    // Session timeout + the 300 ms and 200 ms close graces + one final
    // KILL_EXIT_GRACE_MS + scheduling headroom. A regression that drops the
    // bounded wait on the exit promise makes this bound trip.
    const bound = 100 + 300 + 200 + KILL_EXIT_GRACE_MS + 2_000;
    expect(Date.now() - started).toBeLessThan(bound);
    // The app-server is the last child spawned (after `--version`). On a normal
    // exit no tracker cleanup runs, so close() alone must release its pipes and
    // handle or the CLI stays open.
    const child = platform.children.at(-1);
    expect(child?.pid).toBeDefined();
    expect(child?.stdin?.destroyed).toBe(true);
    expect(child?.stdout?.destroyed).toBe(true);
    expect(child?.stderr?.destroyed).toBe(true);
    expect(platform.unrefed.has(child?.pid as number)).toBe(true);
  });
});
