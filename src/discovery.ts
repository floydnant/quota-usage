import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { accountStateAvailable, inspectAccountDirectory } from './account-state.js';
import { ConfigStore, DEFAULT_CONFIG } from './config.js';
import { UsageError } from './errors.js';
import { accountOrder } from './selectors.js';
import type { AccountConfig, Provider, UsageConfig, UsageErrorData } from './types.js';

/** A missing registration file is valid for an entirely discovered inventory. */
export async function loadAccountConfig(store: ConfigStore): Promise<UsageConfig> {
  return (await store.exists()) ? store.load() : structuredClone(DEFAULT_CONFIG);
}

export interface AccountInventory {
  accounts: AccountConfig[];
  errors: UsageErrorData[];
}

export async function existingAccounts(accounts: AccountConfig[]): Promise<AccountInventory> {
  const checks = await Promise.allSettled(accounts.map(accountStateAvailable));
  const available: AccountConfig[] = [];
  const errors: UsageErrorData[] = [];
  checks.forEach((check, index) => {
    const account = accounts[index] as AccountConfig;
    if (check.status === 'fulfilled') {
      if (check.value) available.push(account);
    } else {
      errors.push(
        new UsageError(
          'invalid_configuration',
          `Cannot inspect subscription directory for ${account.provider}:${account.label}`,
          { provider: account.provider, accountLabel: account.label },
        ).data,
      );
    }
  });
  return { accounts: available.sort(accountOrder), errors };
}

/** Inspect directory names and metadata only; vendor CLIs determine authentication. */
export async function discoverAccounts(
  registered: AccountConfig[],
  home: string,
  discover = true,
): Promise<AccountInventory> {
  const { accounts, errors } = await existingAccounts(registered);
  if (!discover) return { accounts, errors };
  const labels = new Set(registered.map((account) => `${account.provider}:${account.label}`));
  const paths = new Set(
    await Promise.all(
      registered.map(
        async (account) =>
          `${account.provider}:${await realpath(account.stateDir).catch(() => account.stateDir)}`,
      ),
    ),
  );
  let entries;
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    errors.push(
      new UsageError('invalid_configuration', 'Could not scan home for subscription directories')
        .data,
    );
    return { accounts, errors };
  }
  const reservedLabels = new Set(
    entries.flatMap((entry) => {
      const match = /^\.(codex|claude)(?:-([a-z0-9_-]+))?$/.exec(entry.name);
      return match ? [`${match[1]}:${match[2] ?? 'default'}`] : [];
    }),
  );
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^\.(codex|claude)(?:-([a-z0-9_-]+))?$/.exec(entry.name);
    if (!match || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const provider = match[1] as Provider;
    let label = match[2] ?? 'default';
    if (registered.some((account) => account.provider === provider && account.label === label))
      continue;
    const baseLabel = label;
    let suffix = 2;
    while (
      labels.has(`${provider}:${label}`) ||
      (label !== baseLabel && reservedLabels.has(`${provider}:${label}`))
    ) {
      label = `${baseLabel}-${suffix++}`;
    }
    const key = `${provider}:${label}`;
    const claudeDefault = provider === 'claude' && match[2] === undefined;
    try {
      const requested = join(home, entry.name);
      const directory = await inspectAccountDirectory(requested, claudeDefault);
      if (!directory) continue;
      const { stateDir, discoveryKey } = directory;
      if (paths.has(`${provider}:${stateDir}`)) continue;
      accounts.push({
        provider,
        label,
        stateDir,
        ownership: 'external',
        discoveryKey,
        discoveryPath: requested,
        directoryName: entry.name,
        ...(claudeDefault ? { claudeDefault: true } : {}),
      });
      labels.add(key);
      paths.add(`${provider}:${stateDir}`);
    } catch {
      errors.push(
        new UsageError(
          'invalid_configuration',
          `Cannot inspect subscription directory for ${key}`,
          {
            provider,
            accountLabel: label,
          },
        ).data,
      );
    }
  }
  return { accounts: accounts.sort(accountOrder), errors };
}
