import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { UsageError } from './errors.js';
import type { Provider } from './types.js';

export type TrashLayout = 'freedesktop' | 'flat';

export interface AppPaths {
  homeDir: string;
  configDir: string;
  configFile: string;
  backupFile: string;
  dataDir: string;
  managedRoot: string;
  binDir: string;
  cacheDir: string;
  trashDir: string;
  trashLayout: TrashLayout;
}

function xdgBase(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const value = env[variable];
  return value && isAbsolute(value) ? value : fallback;
}

/**
 * An explicit `home` is a self-contained root: the ambient environment applies
 * only when the real home directory is used or `env` is passed.
 */
export function appPaths(
  home?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = home === undefined ? process.env : {},
): AppPaths {
  const homeDir = home ?? homedir();
  const linux = platform === 'linux';
  const base = (variable: string, fallback: string): string =>
    linux ? xdgBase(env, variable, fallback) : fallback;
  const configDir = join(base('XDG_CONFIG_HOME', join(homeDir, '.config')), 'usage');
  const dataHome = base('XDG_DATA_HOME', join(homeDir, '.local', 'share'));
  const dataDir = join(dataHome, 'usage');
  return {
    homeDir,
    configDir,
    configFile: join(configDir, 'config.yaml'),
    backupFile: join(configDir, 'config.yaml.bak'),
    dataDir,
    managedRoot: join(dataDir, 'accounts'),
    binDir: join(dataDir, 'bin'),
    cacheDir: linux
      ? join(base('XDG_CACHE_HOME', join(homeDir, '.cache')), 'usage')
      : join(homeDir, 'Library', 'Caches', 'usage'),
    trashDir: linux ? join(dataHome, 'Trash') : join(homeDir, '.Trash'),
    trashLayout: linux ? 'freedesktop' : 'flat',
  };
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function canonicalExistingPath(path: string): Promise<string> {
  if (!isAbsolute(path)) path = resolve(path);
  try {
    return await realpath(path);
  } catch (error) {
    throw new UsageError('invalid_configuration', `State directory does not exist: ${path}`, {
      cause: error,
    });
  }
}

export function defaultStateDir(
  provider: Provider,
  env: NodeJS.ProcessEnv,
  home = homedir(),
): string {
  return provider === 'codex'
    ? resolve(env.CODEX_HOME ?? join(home, '.codex'))
    : resolve(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'));
}

export async function assertSafeManagedTarget(
  target: string,
  provider: Provider,
  label: string,
  paths: AppPaths,
): Promise<void> {
  const expected = join(paths.managedRoot, provider, label);
  if (target !== expected) {
    throw new UsageError(
      'invalid_configuration',
      `Managed path is not the expected account path: ${target}`,
    );
  }
  const rel = relative(paths.managedRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split('/').length !== 2) {
    throw new UsageError('invalid_configuration', `Unsafe managed account path: ${target}`);
  }
  const stat = await lstat(target).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new UsageError(
      'invalid_configuration',
      `Managed account path is missing or unsafe: ${target}`,
    );
  }
  if ((await realpath(target)) !== target) {
    throw new UsageError(
      'invalid_configuration',
      `Managed account path contains a symlink: ${target}`,
    );
  }
}
