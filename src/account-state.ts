import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { UsageError } from './errors.js';
import type { AccountConfig } from './types.js';

/** Metadata only: never open vendor credentials or create a state directory. */
export async function inspectAccountDirectory(
  path: string,
  claudeDefault = false,
): Promise<{ stateDir: string; discoveryKey: string } | undefined> {
  try {
    const stateDir = await realpath(path);
    const info = await stat(stateDir);
    if (!info.isDirectory()) return undefined;
    const discoveryKey = createHash('sha256')
      .update(
        `${stateDir}\0${info.dev}\0${info.ino}\0${info.birthtimeMs}${claudeDefault ? '\0default' : ''}`,
      )
      .digest('hex');
    return { stateDir, discoveryKey };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new UsageError('invalid_configuration', 'Cannot inspect subscription directory', {
      cause: error,
    });
  }
}

export async function accountStateAvailable(account: AccountConfig): Promise<boolean> {
  const directory = await inspectAccountDirectory(
    account.discoveryPath ?? account.stateDir,
    account.claudeDefault,
  );
  return (
    directory !== undefined &&
    (account.discoveryKey === undefined ||
      (directory.stateDir === account.stateDir && directory.discoveryKey === account.discoveryKey))
  );
}

export async function assertAccountStateAvailable(account: AccountConfig): Promise<void> {
  if (!(await accountStateAvailable(account))) {
    throw new UsageError(
      'invalid_configuration',
      `Subscription directory is missing or changed for ${account.provider}:${account.label}`,
      { provider: account.provider, accountLabel: account.label },
    );
  }
}
