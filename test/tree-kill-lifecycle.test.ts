import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { childOwned, ProcessTracker, runProcess } from '../src/processes.js';
import { runUpdateCommand } from '../src/update-checkout.js';

// Tree kills really run, but the promise they return is held open until the
// test releases it. That makes "settles only after the tree kill has finished"
// observable even though taskkill usually ends the tree before the root exits.
const gate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  return {
    calls: 0,
    held: Promise.resolve(),
    hold(): void {
      this.held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release(): void {
      release();
    },
  };
});

vi.mock('../src/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform.js')>();
  const held =
    <A extends unknown[]>(kill: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      gate.calls += 1;
      await kill(...args);
      await gate.held;
    };
  return {
    ...actual,
    killOwnedTree: held(actual.killOwnedTree),
    killWindowsTree: held(actual.killWindowsTree),
  };
});

const IDLE = ['-e', 'setInterval(()=>{},1000)'];

function observe(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  const done = (): void => {
    state.settled = true;
  };
  void promise.then(done, done);
  return state;
}

/** Waits for a real exit, then gives any premature settlement a chance to happen. */
async function afterExit(pid: number): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe('owned tree kills are drained before shutdown completes', () => {
  afterEach(() => {
    gate.release();
    gate.held = Promise.resolve();
    gate.calls = 0;
  });

  it('keeps ProcessTracker.cleanup pending until the tree kill has finished', async () => {
    const child = spawn(process.execPath, IDLE, { stdio: 'ignore' });
    try {
      const tracker = new ProcessTracker();
      tracker.track(childOwned(child));
      gate.hold();
      const cleanup = tracker.cleanup(20);
      const state = observe(cleanup);
      await afterExit(child.pid ?? 0);
      expect(gate.calls).toBeGreaterThan(0);
      expect(state.settled).toBe(false);
      gate.release();
      await cleanup;
      expect(tracker.size).toBe(0);
    } finally {
      gate.release();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  it('keeps a timed out runProcess pending until its tree kills have finished', async () => {
    const tracker = new ProcessTracker();
    gate.hold();
    const run = runProcess(process.execPath, IDLE, { timeoutMs: 300, tracker });
    const state = observe(run);
    try {
      await expect.poll(() => gate.calls, { timeout: 5_000 }).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(state.settled).toBe(false);
      gate.release();
      await expect(run).rejects.toMatchObject({ data: { code: 'timeout' } });
      expect(tracker.size).toBe(0);
    } finally {
      gate.release();
      await tracker.cleanup(20);
    }
  });

  describe.runIf(process.platform === 'win32')('Windows updater commands', () => {
    const script = [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)",
    ];

    async function heldUntilTreeKill(
      start: (args: string[]) => Promise<unknown>,
      stop: () => void,
      failure: 'cancelled' | 'timeout',
    ): Promise<void> {
      const dir = await mkdtemp(join(tmpdir(), 'usage-held-kill-'));
      const pidFile = join(dir, 'pid');
      gate.hold();
      const run = start([...script, pidFile]);
      const state = observe(run);
      try {
        await expect
          .poll(async () => Number(await readFile(pidFile, 'utf8').catch(() => '0')), {
            timeout: 10_000,
          })
          .toBeGreaterThan(0);
        const pid = Number(await readFile(pidFile, 'utf8'));
        stop();
        await afterExit(pid);
        expect(gate.calls).toBeGreaterThan(0);
        expect(state.settled).toBe(false);
        gate.release();
        await expect(run).rejects.toMatchObject({ failure });
      } finally {
        gate.release();
        await run.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('does not settle a cancelled command before its taskkill has finished', async () => {
      const controller = new AbortController();
      await heldUntilTreeKill(
        (args) => runUpdateCommand(process.execPath, args, tmpdir(), 30_000, controller.signal),
        () => {
          controller.abort();
        },
        'cancelled',
      );
    });

    it('does not settle a timed out command before its taskkill has finished', async () => {
      await heldUntilTreeKill(
        (args) => runUpdateCommand(process.execPath, args, tmpdir(), 2_000),
        () => undefined,
        'timeout',
      );
    });
  });
});
