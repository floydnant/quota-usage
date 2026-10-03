import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join, normalize } from 'node:path';

export const isWindows = process.platform === 'win32';

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const NPM_BIN_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/** Executable extensions Windows tries for a bare command name, in PATHEXT order. */
export function executableExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isWindows) return [''];
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
}

/** Candidate files for a command path; Windows cannot execute extensionless files. */
export function executableCandidates(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isWindows) return [path];
  const extensions = executableExtensions(env);
  const suffixed = extensions.map((extension) => `${path}${extension}`);
  return extensions.includes(extname(path).toLowerCase()) ? [path, ...suffixed] : suffixed;
}

/** Resolves a bare command such as `npm` to the file Windows would run (`npm.cmd`). */
export function findCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isWindows) return command;
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory) continue;
    const match = executableCandidates(join(directory, command), env).find((candidate) =>
      existsSync(candidate),
    );
    if (match) return match;
  }
  return command;
}

// Batch files cannot be spawned without a shell (CVE-2024-27980), so they run
// through cmd.exe with every argument quoted and every metacharacter escaped.
// The escaping follows cross-spawn, which npm itself relies on.
function escapeCmdArgument(argument: string, doubleEscape: boolean): string {
  let escaped = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META, '^$1');
  return doubleEscape ? escaped.replace(CMD_META, '^$1') : escaped;
}

export function isBatchFile(executable: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(executable);
}

/** `spawn` without a shell that can also start Windows `.cmd`/`.bat` shims safely. */
export function spawnExecutable(
  executable: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const base: SpawnOptions = { ...options, shell: false, windowsHide: true };
  if (!isBatchFile(executable)) return spawn(executable, args, base);
  const doubleEscape = NPM_BIN_SHIM.test(executable);
  const line = [
    normalize(executable).replace(CMD_META, '^$1'),
    ...args.map((argument) => escapeCmdArgument(argument, doubleEscape)),
  ].join(' ');
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...base,
    windowsVerbatimArguments: true,
  });
}

/** Upper bound on one `taskkill` run so a cleanup path never waits on it forever. */
const TREE_KILL_TIMEOUT_MS = 5_000;

/**
 * How long a killed child gets to exit before the next step: a direct kill after
 * an unsuccessful tree kill, or giving up on a child that still does not exit.
 */
export const KILL_EXIT_GRACE_MS = 2_000;

/**
 * Resolves `true` once `promise` settles, or `false` after `ms`. It never
 * rejects, and its timer is cleared and unref'd so it never holds the process open.
 */
export function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, ms, false);
    timer.unref();
  });
  const done = promise.then(
    () => true,
    () => true,
  );
  return Promise.race([done, expired]).finally(() => clearTimeout(timer));
}

/** Resolves `true` once `child` has exited, or `false` after `ms`. */
export function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(finish, ms, false);
    timer.unref();
    child.once('exit', onExit);
  });
}

/**
 * Terminates an owned child. On Windows signals cannot reach grandchildren and a
 * `.cmd` shim leaves its real program running, so the owned tree is ended with
 * `taskkill /T` rooted at the child this program started. If taskkill fails,
 * errors, or times out and the child has not exited within `KILL_EXIT_GRACE_MS`,
 * the child itself is killed directly. The returned promise settles once that has
 * finished, so callers can drain it; on POSIX the signal is delivered
 * synchronously and the promise is already resolved. It never rejects.
 */
export function killOwnedTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  if (!isWindows || child.pid === undefined) {
    child.kill(signal);
    return Promise.resolve();
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return killWindowsTree(child.pid)
    .then(() => exitsWithin(child, KILL_EXIT_GRACE_MS))
    .then((exited) => {
      if (!exited) child.kill(signal);
    })
    .catch(() => undefined);
}

/**
 * Runs `taskkill /T /F` for an owned process tree and settles when taskkill
 * exits or fails to start. A taskkill that outlives `timeoutMs` is itself ended
 * and the promise settles anyway. It never rejects: it runs on cleanup paths.
 */
export function killWindowsTree(pid: number, timeoutMs = TREE_KILL_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Some spawn failures throw synchronously instead of emitting 'error'.
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    killer.once('error', done);
    killer.once('close', done);
  });
}
