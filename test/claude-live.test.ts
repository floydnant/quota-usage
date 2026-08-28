import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeLiveAdapter,
  ensureNodePtyHelperExecutable,
  nodePtyHelperStatus,
  type PtyModule,
  type PtyProcess,
} from '../src/providers/claude-live.js';
import { ProcessTracker } from '../src/processes.js';
import type { AccountConfig } from '../src/types.js';

class FakePty implements PtyProcess {
  readonly pid = 99999;
  private data?: (value: string) => void;
  private exit?: () => void;
  writes: string[] = [];
  kills: string[] = [];
  onData(callback: (data: string) => void): { dispose(): void } {
    this.data = callback;
    return { dispose: () => undefined };
  }
  onExit(callback: () => void): { dispose(): void } {
    this.exit = callback;
    queueMicrotask(() => this.data?.('Claude Code Max\n❯'));
    return { dispose: () => undefined };
  }
  write(data: string): void {
    this.writes.push(data);
    if (data.includes('/usage'))
      queueMicrotask(() =>
        this.data?.(
          'Plan usage\nCurrent session (5 hour) 82% used resets in 47m\nWeekly (7 day) 39% used resets in 3d 8h',
        ),
      );
    if (data.includes('/exit')) queueMicrotask(() => this.exit?.());
  }
  kill(signal = 'SIGTERM'): void {
    this.kills.push(signal);
    this.exit?.();
  }
}

const account: AccountConfig = {
  provider: 'claude',
  label: 'work',
  stateDir: '/tmp/claude-work',
  ownership: 'external',
};

describe('Claude live PTY flow', () => {
  it('repairs a packaged spawn-helper that lost its executable bit', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'node-pty-helper-'));
    const prebuild = join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`);
    await mkdir(prebuild, { recursive: true });
    await writeFile(join(prebuild, 'pty.node'), 'fixture');
    const helper = join(prebuild, 'spawn-helper');
    await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o600 });

    await expect(nodePtyHelperStatus(packageRoot)).resolves.toMatchObject({
      path: helper,
      mode: 0o600,
      executable: false,
    });
    await expect(ensureNodePtyHelperExecutable(packageRoot)).resolves.toMatchObject({
      path: helper,
      mode: 0o711,
      executable: true,
    });
    expect((await stat(helper)).mode & 0o111).toBe(0o111);
  });

  it('waits semantically, sends /usage, exits, and tracks only its PTY', async () => {
    const child = new FakePty();
    const module: PtyModule = {
      spawn: (_file, args, options) => {
        expect(args).toEqual([]);
        expect(options.cwd).toBe(homedir());
        return child;
      },
    };
    const tracker = new ProcessTracker();
    const adapter = new ClaudeLiveAdapter('/bin/echo', tracker, module);
    adapter.version = async () => '2.1.238';
    const result = await adapter.collect(account, {
      timeoutMs: 1_000,
      now: new Date('2026-08-27T18:00:00Z'),
    });
    expect(result.windows).toHaveLength(2);
    expect(child.writes).toContain('/usage\r');
    expect(child.writes).toContain('/exit\r');
    expect(tracker.size).toBe(0);
  });

  it('accepts the session-only home trust prompt before sending /usage', async () => {
    const child = new FakePty();
    child.onExit = (callback) => {
      (child as unknown as { exit?: () => void }).exit = callback;
      queueMicrotask(() =>
        (child as unknown as { data?: (value: string) => void }).data?.(
          'Do you trust the files in this folder?',
        ),
      );
      return { dispose: () => undefined };
    };
    const originalWrite = child.write.bind(child);
    child.write = (data) => {
      child.writes.push(data);
      if (data === '\u001b[A\r') {
        queueMicrotask(() =>
          (child as unknown as { data?: (value: string) => void }).data?.(
            '\u001b[2J\u001b[HClaude Code Max\n❯',
          ),
        );
      } else {
        originalWrite(data);
      }
    };
    const adapter = new ClaudeLiveAdapter('/bin/echo', new ProcessTracker(), {
      spawn: () => child,
    });
    adapter.version = async () => '2.1.238';
    await expect(adapter.collect(account, { timeoutMs: 2_000 })).resolves.toHaveProperty(
      'status',
      'live',
    );
    expect(child.writes).toContain('\u001b[A\r');
    expect(child.writes).toContain('/usage\r');
  });

  it('answers terminal negotiation and rejects first-run setup explicitly', async () => {
    const negotiating = new FakePty();
    negotiating.onExit = (callback) => {
      (negotiating as unknown as { exit?: () => void }).exit = callback;
      queueMicrotask(() =>
        (negotiating as unknown as { data?: (value: string) => void }).data?.(
          '\u001b]11;?\u0007\u001b[>0qClaude Code v2.1.247\n❯',
        ),
      );
      return { dispose: () => undefined };
    };
    const adapter = new ClaudeLiveAdapter('/bin/echo', new ProcessTracker(), {
      spawn: () => negotiating,
    });
    adapter.version = async () => '2.1.247';
    await expect(adapter.collect(account, { timeoutMs: 1_000 })).resolves.toHaveProperty(
      'status',
      'live',
    );
    expect(negotiating.writes).toContain('\u001b]11;rgb:0000/0000/0000\u001b\\');
    expect(negotiating.writes).toContain('\u001bP>|xterm.js(6.0.0)\u001b\\');

    const onboarding = new FakePty();
    onboarding.onExit = (callback) => {
      (onboarding as unknown as { exit?: () => void }).exit = callback;
      queueMicrotask(() =>
        (onboarding as unknown as { data?: (value: string) => void }).data?.(
          'Welcome to Claude Code\nChoose the text style\nEnter selection [1-7]',
        ),
      );
      return { dispose: () => undefined };
    };
    const blocked = new ClaudeLiveAdapter('/bin/echo', new ProcessTracker(), {
      spawn: () => onboarding,
    });
    blocked.version = async () => '2.1.247';
    await expect(blocked.collect(account, { timeoutMs: 1_000 })).rejects.toThrow(
      'first-run setup is incomplete',
    );
  });

  it('times out, escalates cleanup, and does not retry', async () => {
    const child = new FakePty();
    child.write = (data) => {
      child.writes.push(data);
    };
    child.onExit = (callback) => {
      (child as unknown as { exit?: () => void }).exit = callback;
      return { dispose: () => undefined };
    };
    const module: PtyModule = { spawn: () => child };
    const adapter = new ClaudeLiveAdapter('/bin/echo', new ProcessTracker(), module);
    adapter.version = async () => '2.1.238';
    await expect(adapter.collect(account, { timeoutMs: 20 })).rejects.toMatchObject({
      data: { code: 'timeout' },
    });
    expect(child.kills).toContain('SIGTERM');
  });

  it('checks the settled minimum version and can load the installed PTY', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-version-'));
    const make = async (version: string) => {
      const file = join(dir, version.replaceAll('.', '-'));
      await writeFile(file, `#!/bin/sh\necho '${version} (Claude Code)'\n`);
      await chmod(file, 0o700);
      return file;
    };
    await expect(
      new ClaudeLiveAdapter(await make('2.1.237'), new ProcessTracker()).version(),
    ).rejects.toMatchObject({ data: { code: 'unsupported_vendor_version' } });
    await expect(
      new ClaudeLiveAdapter(await make('2.1.238'), new ProcessTracker()).version(),
    ).resolves.toBe('2.1.238');
    await expect(
      new ClaudeLiveAdapter('/bin/echo', new ProcessTracker()).loadPty(),
    ).resolves.toHaveProperty('spawn');
  });

  it('reports an early provider exit', async () => {
    const child = new FakePty();
    child.onExit = (callback) => {
      queueMicrotask(callback);
      return { dispose: () => undefined };
    };
    const adapter = new ClaudeLiveAdapter('/bin/echo', new ProcessTracker(), {
      spawn: () => child,
    });
    adapter.version = async () => '2.1.238';
    await expect(adapter.collect(account, { timeoutMs: 500 })).rejects.toThrow('exited before');
  });

  it.each([
    ['Select login method:', 'official login setup'],
    ['Network error: unable to connect', 'network error'],
    ['Update available: new version is available', 'upgrade notice'],
  ])('reports the alternate provider screen %s', async (screen, message) => {
    const child = new FakePty();
    child.onExit = (callback) => {
      (child as unknown as { exit?: () => void }).exit = callback;
      queueMicrotask(() => (child as unknown as { data?: (value: string) => void }).data?.(screen));
      return { dispose: () => undefined };
    };
    const adapter = new ClaudeLiveAdapter('/bin/echo', new ProcessTracker(), {
      spawn: () => child,
    });
    adapter.version = async () => '2.1.247';
    await expect(adapter.collect(account, { timeoutMs: 1_000 })).rejects.toThrow(message);
  });

  it('cleans an owned PTY when interrupted', async () => {
    const child = new FakePty();
    child.onExit = (callback) => {
      (child as unknown as { exit?: () => void }).exit = callback;
      return { dispose: () => undefined };
    };
    const tracker = new ProcessTracker();
    const removeSignals = tracker.installSignalHandlers();
    const adapter = new ClaudeLiveAdapter('/bin/echo', tracker, { spawn: () => child });
    adapter.version = async () => '2.1.238';
    const collection = adapter.collect(account, { timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.emit('SIGINT', 'SIGINT');
    await expect(collection).rejects.toThrow('exited before');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(child.kills).toContain('SIGTERM');
    removeSignals();
    process.exitCode = 0;
  });
});
