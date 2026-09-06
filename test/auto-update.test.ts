import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { startAutoUpdate } from '../src/auto-update.js';
import { runUpdateCommand, updateCheckout, type UpdateCommand } from '../src/update-checkout.js';

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'usage-updater-')));
  const root = join(home, 'checkout');
  const remote = join(home, 'remote.git');
  const publisher = join(home, 'publisher');
  const state = join(home, 'state');
  await mkdir(root);
  const git = async (cwd: string, args: string[]) => {
    const result = await runUpdateCommand(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      cwd,
      5_000,
    );
    if (result.code) throw new Error(`fixture git ${args[0]} failed`);
    return result.stdout;
  };
  await git(home, ['init', '--bare', remote]);
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'quota-usage' }));
  await writeFile(join(root, 'version.txt'), 'old');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-u', 'origin', 'main']);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'cli.js'), 'old build');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'version'), 'old deps');
  await git(home, ['clone', '--branch', 'main', remote, publisher]);
  await writeFile(join(publisher, 'version.txt'), 'new');
  await git(publisher, ['commit', '-am', 'update']);
  await git(publisher, ['push', 'origin', 'main']);
  const npmCalls: string[] = [];
  const run: UpdateCommand = async (name, args, cwd, timeout) => {
    if (name !== 'npm') return runUpdateCommand(name, args, cwd, timeout);
    npmCalls.push(args.join(' '));
    if (args[0] === 'ci') {
      await mkdir(join(cwd, 'node_modules'));
      await writeFile(join(cwd, 'node_modules', 'version'), 'new deps');
    } else {
      await mkdir(join(cwd, 'dist'));
      await writeFile(
        join(cwd, 'dist', 'cli.js'),
        `${await readFile(join(cwd, 'version.txt'), 'utf8')} build`,
      );
    }
    return { code: 0, stdout: '' };
  };
  return { home, root, state, git, run, npmCalls };
}

describe('background checkout updater', () => {
  it('fast-forwards main and installs a staged build, then skips rebuilding unchanged revisions', async () => {
    const f = await fixture();
    expect(await updateCheckout(f.root, f.state, f.run)).toBe('updated');
    expect(await readFile(join(f.root, 'version.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('new build');
    expect(await readFile(join(f.root, 'node_modules', 'version'), 'utf8')).toBe('new deps');
    expect(await f.git(f.root, ['status', '--porcelain'])).toBe('');
    expect(
      (await f.git(f.root, ['worktree', 'list', '--porcelain'])).match(/worktree /g),
    ).toHaveLength(1);
    expect(f.npmCalls).toHaveLength(2);
    expect(await updateCheckout(f.root, f.state, f.run)).toBeUndefined();
    expect(f.npmCalls).toHaveLength(2);
    await expect(stat(join(f.state, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(f.state, 'failure.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a dirty checkout without changing sources or the runnable version', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'version.txt'), 'local changes');
    expect(await updateCheckout(f.root, f.state, f.run)).toBe('dirty');
    expect(await readFile(join(f.root, 'version.txt'), 'utf8')).toBe('local changes');
    expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('old build');
    expect(f.npmCalls).toEqual([]);
  });

  it('refuses other branches and divergent main without switching, resetting, or merging', async () => {
    const f = await fixture();
    await f.git(f.root, ['switch', '-c', 'feature']);
    expect(await updateCheckout(f.root, f.state, f.run)).toBe('branch');
    await f.git(f.root, ['switch', 'main']);
    await writeFile(join(f.root, 'local.txt'), 'local');
    await f.git(f.root, ['add', 'local.txt']);
    await f.git(f.root, ['commit', '-m', 'local commit']);
    const before = await f.git(f.root, ['rev-parse', 'HEAD']);
    expect(await updateCheckout(f.root, f.state, f.run)).toBe('diverged');
    expect(await f.git(f.root, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('keeps the old build and source when dependency installation or building fails', async () => {
    const f = await fixture();
    for (const stage of ['ci', 'run']) {
      const result = await updateCheckout(f.root, f.state, async (name, args, cwd, timeout) =>
        name === 'npm' && args[0] === stage
          ? { code: 1, stdout: 'untrusted secret output' }
          : f.run(name, args, cwd, timeout),
      );
      expect(result).toBe(stage === 'ci' ? 'install' : 'build');
      expect(await readFile(join(f.root, 'version.txt'), 'utf8')).toBe('old');
      expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('old build');
      expect(await readFile(join(f.root, 'node_modules', 'version'), 'utf8')).toBe('old deps');
    }
  });

  it('rechecks for edits made while building and serializes concurrent invocations', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = updateCheckout(f.root, f.state, async (name, args, cwd, timeout) => {
      if (name === 'npm' && args[0] === 'ci') {
        entered();
        await blocked;
      }
      return f.run(name, args, cwd, timeout);
    });
    await ready;
    await updateCheckout(f.root, f.state, f.run);
    expect(f.npmCalls).toEqual([]);
    await writeFile(join(f.root, 'version.txt'), 'edited during build');
    release();
    expect(await first).toBe('changed');
    expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('old build');
  });

  it('bounds command execution and classifies unreachable remotes safely', async () => {
    await expect(
      runUpdateCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmpdir(), 50),
    ).rejects.toMatchObject({ failure: 'timeout' });
    const f = await fixture();
    await f.git(f.root, ['remote', 'set-url', 'origin', join(f.home, 'missing.git')]);
    expect(await updateCheckout(f.root, f.state, f.run)).toBe('fetch');
  });

  it('restores runnable files after publication failure and retries the pending build', async () => {
    const f = await fixture();
    const result = await updateCheckout(f.root, f.state, async (name, args, cwd, timeout) => {
      const result = await f.run(name, args, cwd, timeout);
      if (name === 'npm' && args[0] === 'run')
        await rm(join(cwd, 'node_modules'), { recursive: true });
      return result;
    });
    expect(result).toBe('publish');
    expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('old build');
    expect(await readFile(join(f.root, 'node_modules', 'version'), 'utf8')).toBe('old deps');
    await updateCheckout(f.root, f.state, f.run);
    expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('new build');
    await expect(stat(join(f.state, 'build-pending'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims abandoned locks, rejects missing build output, and safely handles spawn failures', async () => {
    const f = await fixture();
    await mkdir(f.state);
    const lock = join(f.state, 'lock');
    await writeFile(lock, 'abandoned');
    await utimes(lock, new Date(0), new Date(0));
    const result = await updateCheckout(f.root, f.state, async (name, args, cwd, timeout) =>
      name === 'npm' && args[0] === 'run'
        ? { code: 0, stdout: '' }
        : f.run(name, args, cwd, timeout),
    );
    expect(result).toBe('build');
    expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('old build');
    await expect(
      runUpdateCommand(join(f.home, 'missing-executable'), [], f.home, 100),
    ).rejects.toMatchObject({ failure: 'worker' });
  });

  it('reports an installed update once on close and stays quiet when no update is needed', async () => {
    const f = await fixture();
    const messages: string[] = [];
    const options = {
      enabled: true,
      root: f.root,
      stateDir: f.state,
      run: f.run,
      report: (message: string) => {
        messages.push(message);
      },
    };
    const update = startAutoUpdate(options);
    try {
      await expect
        .poll(() => readFile(join(f.root, 'dist', 'cli.js'), 'utf8').catch(() => ''))
        .toBe('new build');
      expect(messages).toEqual([]);
    } finally {
      await update.close();
    }
    await update.close();
    expect(messages).toEqual([
      'usage: CLI updated successfully; the new version will be used on the next run.',
    ]);
    messages.length = 0;
    let checked = false;
    const unchanged = startAutoUpdate({
      ...options,
      run: async (...args) => {
        const result = await f.run(...args);
        if (args[1][0] === 'rev-parse' && args[1][1] === 'FETCH_HEAD') checked = true;
        return result;
      },
    });
    try {
      await expect
        .poll(async () => checked && !(await stat(join(f.state, 'lock')).catch(() => undefined)))
        .toBe(true);
    } finally {
      await unchanged.close();
    }
    expect(messages).toEqual([]);
  });

  it('reports completed failures only on close and only once', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'version.txt'), 'dirty');
    const messages: string[] = [];
    let finished!: () => void;
    const ready = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const update = startAutoUpdate({
      enabled: true,
      root: f.root,
      stateDir: f.state,
      run: async (...args) => {
        const result = await f.run(...args);
        if (args[1][0] === 'status') finished();
        return result;
      },
      report: (message) => {
        messages.push(message);
      },
    });
    await ready;
    await delay(20);
    expect(messages).toEqual([]);
    await update.close();
    await update.close();
    expect(messages).toEqual([
      'usage: auto-update failed: working tree is dirty; commit or stash changes before updating',
    ]);
    const disabled = startAutoUpdate({ enabled: false });
    disabled.cancel();
    await disabled.close();
    await startAutoUpdate({ enabled: true, root: join(f.home, 'missing') }).close();
  });

  it('cancels a running build, kills stubborn descendants, and drains cleanup before close', async () => {
    const f = await fixture();
    const ready = join(f.home, 'ready');
    const messages: string[] = [];
    const script = `
      const {spawn} = require('node:child_process');
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e',
        'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'
      ], {stdio: 'inherit'});
      fs.writeFileSync(process.argv[1], JSON.stringify([process.pid,child.pid]));
      setInterval(()=>{},1000);
    `;
    const update = startAutoUpdate({
      enabled: true,
      root: f.root,
      stateDir: f.state,
      run: (name, args, cwd, timeout, signal) =>
        name === 'npm'
          ? runUpdateCommand(process.execPath, ['-e', script, ready], cwd, timeout, signal)
          : runUpdateCommand(name, args, cwd, timeout, signal),
      report: (message) => {
        messages.push(message);
      },
    });
    try {
      await expect
        .poll(() =>
          stat(ready).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      const pids = JSON.parse(await readFile(ready, 'utf8')) as number[];
      expect(messages).toEqual([]);
      const started = Date.now();
      update.cancel();
      await update.close();
      expect(Date.now() - started).toBeLessThan(3_000);
      for (const pid of pids) {
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
      }
      expect(messages).toEqual([
        'usage: auto-update failed: update cancelled because usage closed; retry on the next run',
      ]);
      expect(await readFile(join(f.root, 'dist', 'cli.js'), 'utf8')).toBe('old build');
      expect(await readFile(join(f.root, 'version.txt'), 'utf8')).toBe('old');
      await expect(stat(join(f.state, 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await f.git(f.root, ['worktree', 'list', '--porcelain'])).match(/worktree /g),
      ).toHaveLength(1);
    } finally {
      await update.close();
    }
  });

  it('does not spawn commands when already cancelled and keeps unexpected errors private', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runUpdateCommand('missing', [], tmpdir(), 100, controller.signal),
    ).rejects.toMatchObject({ failure: 'cancelled' });
    const f = await fixture();
    expect(
      await updateCheckout(f.root, f.state, () => {
        throw new Error('secret');
      }),
    ).toBe('repository');
    const update = startAutoUpdate({
      enabled: true,
      root: f.root,
      stateDir: f.state,
      report: () => {},
    });
    await update.close();
  });
});
