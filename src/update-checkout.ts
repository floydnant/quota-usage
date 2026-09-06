import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UsageError } from './errors.js';

export const UPDATE_FAILURES = {
  dirty: 'working tree is dirty; commit or stash changes before updating',
  branch: 'checkout is not on main',
  repository: 'could not verify the usage repository',
  fetch: 'could not fetch origin/main',
  diverged: 'local main cannot fast-forward to origin/main',
  changed: 'checkout changed while the update was building; update skipped',
  install: 'dependency installation failed',
  build: 'build failed; the previous runnable version was kept',
  publish: 'could not install the rebuilt version; retry on the next run',
  timeout: 'update timed out; retry on the next run',
  cancelled: 'update cancelled because usage closed; retry on the next run',
  worker: 'could not start the background updater',
} as const;
export type UpdateFailure = keyof typeof UPDATE_FAILURES;

const MAX_UPDATE_MS = 5 * 60_000;
class UpdateError extends UsageError {
  constructor(readonly failure: UpdateFailure) {
    super(failure === 'timeout' ? 'timeout' : 'provider_failure', UPDATE_FAILURES[failure]);
  }
}

export interface UpdateCommandResult {
  code: number;
  stdout: string;
}
export type UpdateCommand = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<UpdateCommandResult>;

/** Each command gets its own owned process group, including npm's descendants. */
export const runUpdateCommand: UpdateCommand = (command, args, cwd, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UpdateError('cancelled'));
      return;
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('GIT_') && key !== 'npm_config_prefix',
      ),
    );
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS: '/usr/bin/false',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });
    let stdout = '';
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Owned group already exited. */
        }
      }
    };
    const terminate = (): void => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 300);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      stdout = `${stdout}${data.toString()}`.slice(-256 * 1024);
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      kill('SIGKILL');
      signal?.removeEventListener('abort', terminate);
    };
    child.once('error', () => {
      cleanup();
      reject(new UpdateError('worker'));
    });
    child.once('close', (code) => {
      cleanup();
      if (timedOut) reject(new UpdateError('timeout'));
      else if (signal?.aborted) reject(new UpdateError('cancelled'));
      else resolve({ code: code ?? 1, stdout: stdout.trim() });
    });
  });

export async function updateCheckout(
  root: string,
  stateDir: string,
  run: UpdateCommand = runUpdateCommand,
  signal?: AbortSignal,
): Promise<'updated' | UpdateFailure | undefined> {
  const lock = join(stateDir, 'lock');
  const owner = randomUUID();
  let staging: string | undefined;
  let worktree: string | undefined;
  let acquired = false;
  let preserveStaging = false;
  const keepRecoveryFiles = (): boolean => preserveStaging;
  const deadline = Date.now() + MAX_UPDATE_MS;
  const command = async (
    name: string,
    args: string[],
    cwd: string,
    failure: UpdateFailure,
    timeout = 30_000,
  ): Promise<string> => {
    if (signal?.aborted) throw new UpdateError('cancelled');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UpdateError('timeout');
    const result = await run(name, args, cwd, Math.min(timeout, remaining), signal);
    if (signal?.aborted) throw new UpdateError('cancelled');
    if (result.code !== 0) throw new UpdateError(failure);
    return result.stdout;
  };
  const git = (args: string[], failure: UpdateFailure = 'repository') =>
    command('git', args, root, failure);
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    // A crashed CLI cannot hold the lease indefinitely. Active jobs are bounded
    // to five minutes; an abandoned lock becomes eligible after fifteen minutes.
    const oldLock = await stat(lock).catch(() => undefined);
    if (oldLock && Date.now() - oldLock.mtimeMs > 15 * 60_000)
      await unlink(lock).catch(() => undefined);
    try {
      await writeFile(lock, owner, { flag: 'wx', mode: 0o600 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name !== 'quota-usage' || (await git(['rev-parse', '--show-toplevel'])) !== root)
      throw new UpdateError('repository');
    if ((await git(['branch', '--show-current'])) !== 'main') throw new UpdateError('branch');
    if (await git(['status', '--porcelain', '--untracked-files=normal']))
      throw new UpdateError('dirty');
    const before = await git(['rev-parse', 'HEAD']);
    await git(['fetch', '--no-tags', 'origin', 'main'], 'fetch');
    const target = await git(['rev-parse', 'FETCH_HEAD']);
    const pending = join(stateDir, 'build-pending');
    if (before === target && !(await stat(pending).catch(() => undefined))) return;
    await git(['merge-base', '--is-ancestor', before, target], 'diverged');
    // A sibling worktree shares the filesystem, making artifact renames cheap.
    staging = await mkdtemp(join(dirname(root), '.usage-update-'));
    await chmod(staging, 0o700);
    worktree = join(staging, 'checkout');
    await git(['worktree', 'add', '--detach', worktree, target], 'build');
    await command(
      'npm',
      ['ci', '--include=dev', '--no-audit', '--no-fund'],
      worktree,
      'install',
      180_000,
    );
    await command('npm', ['run', 'build'], worktree, 'build', 120_000);
    if (!(await stat(join(worktree, 'dist', 'cli.js')).catch(() => undefined))?.isFile())
      throw new UpdateError('build');
    if (
      (await git(['branch', '--show-current'])) !== 'main' ||
      (await git(['rev-parse', 'HEAD'])) !== before ||
      (await git(['status', '--porcelain', '--untracked-files=normal']))
    )
      throw new UpdateError('changed');
    await writeFile(pending, target, { mode: 0o600 });
    await git(['merge', '--ff-only', target], 'changed');
    const installed: string[] = [];
    const backups: string[] = [];
    try {
      for (const name of ['node_modules', 'dist']) {
        const destination = join(root, name);
        if (await lstat(destination).catch(() => undefined)) {
          await rename(destination, join(staging, `previous-${name}`));
          backups.push(name);
        }
        await rename(join(worktree, name), destination);
        installed.push(name);
      }
    } catch {
      try {
        for (const name of installed.reverse())
          await rm(join(root, name), { recursive: true, force: true });
        for (const name of backups.reverse())
          await rename(join(staging, `previous-${name}`), join(root, name));
      } catch {
        // Keep recovery copies if the filesystem also refuses rollback.
        preserveStaging = true;
      }
      throw new UpdateError('publish');
    }
    await unlink(pending);
    return 'updated';
  } catch (error) {
    return error instanceof UpdateError ? error.failure : 'repository';
  } finally {
    if (worktree)
      await run('git', ['worktree', 'remove', '--force', worktree], root, 10_000).catch(
        () => undefined,
      );
    if (staging && !keepRecoveryFiles())
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (acquired && (await readFile(lock, 'utf8').catch(() => '')) === owner)
      await unlink(lock).catch(() => undefined);
  }
}
