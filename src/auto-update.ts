import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPaths } from './paths.js';
import { updateCheckout, UPDATE_FAILURES, type UpdateCommand } from './update-checkout.js';

export interface AutoUpdate {
  cancel: () => void;
  /** Cancels unfinished work, drains owned children and cleanup, then reports. */
  close: () => Promise<void>;
}

export function startAutoUpdate(options: {
  enabled: boolean;
  root?: string;
  stateDir?: string;
  run?: UpdateCommand;
  report?: (message: string) => void;
}): AutoUpdate {
  const root = resolve(options.root ?? fileURLToPath(new URL('../', import.meta.url)));
  if (!options.enabled || !existsSync(join(root, '.git')))
    return { cancel: () => {}, close: () => Promise.resolve() };
  const stateDir =
    options.stateDir ??
    join(appPaths().dataDir, 'updates', createHash('sha256').update(root).digest('hex'));
  const controller = new AbortController();
  const task = updateCheckout(root, stateDir, options.run, controller.signal);
  let closing: Promise<void> | undefined;
  const cancel = (): void => {
    controller.abort();
  };
  return {
    cancel,
    close: () => {
      closing ??= (async () => {
        cancel();
        const failure = await task;
        if (failure) {
          const message = `usage: auto-update failed: ${UPDATE_FAILURES[failure]}`;
          if (options.report) options.report(message);
          else process.stderr.write(`${message}\n`);
        }
      })();
      return closing;
    },
  };
}
