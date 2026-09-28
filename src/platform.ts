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

/**
 * Terminates an owned child. On Windows signals cannot reach grandchildren and a
 * `.cmd` shim leaves its real program running, so the owned tree is ended with
 * `taskkill /T` rooted at the child this program started.
 */
export function killOwnedTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!isWindows || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  killWindowsTree(child.pid);
}

export function killWindowsTree(pid: number): void {
  const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  killer.once('error', () => undefined);
}
