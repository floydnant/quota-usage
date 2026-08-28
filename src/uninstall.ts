import { readdir, unlink } from 'node:fs/promises';
import { ConfigStore } from './config.js';
import { restoreClaudeCollector } from './accounts.js';
import type { Confirm } from './prompt.js';

export async function uninstallPreview(store: ConfigStore): Promise<string[]> {
  const config = await store.load();
  const actions = config.accounts
    .filter((account) => account.provider === 'claude' && account.claudeCollector)
    .map(
      (account) =>
        `Restore Claude status line for claude:${account.label} when configuration has not drifted`,
    );
  actions.push(`Remove helper files beneath ${store.paths.binDir}`);
  actions.push(`Remove quota caches beneath ${store.paths.cacheDir}`);
  actions.push(`Offer to remove ${store.paths.configFile}`);
  actions.push('Leave every vendor state directory and login untouched');
  return actions;
}

async function unlinkFiles(path: string): Promise<void> {
  const names = await readdir(path).catch(() => []);
  for (const name of names) await unlink(`${path}/${name}`).catch(() => undefined);
}

export async function uninstall(store: ConfigStore, confirm: Confirm): Promise<string[]> {
  const config = await store.load();
  const preview = await uninstallPreview(store);
  if (!(await confirm(`${preview.map((item) => `- ${item}`).join('\n')}\nContinue?`)))
    return ['Uninstall preparation cancelled.'];
  const messages: string[] = [];
  for (const account of config.accounts.filter((item) => item.provider === 'claude')) {
    const restored = await restoreClaudeCollector(account);
    if (restored.drift) messages.push(restored.drift);
    else if (account.claudeCollector)
      messages.push(`Restored claude:${account.label} status line.`);
  }
  await unlinkFiles(store.paths.binDir);
  await unlinkFiles(store.paths.cacheDir);
  messages.push('Removed usage helper files and quota caches.');
  if (await confirm(`Remove configuration ${store.paths.configFile}?`)) {
    await unlink(store.paths.configFile).catch(() => undefined);
    await unlink(store.paths.backupFile).catch(() => undefined);
    messages.push('Removed usage configuration and backup.');
  } else {
    messages.push('Kept usage configuration.');
  }
  if (config.accounts.some((account) => account.ownership === 'managed')) {
    messages.push(
      'Managed vendor state remains. Remove or purge those accounts separately before npm removal.',
    );
  }
  return messages;
}
