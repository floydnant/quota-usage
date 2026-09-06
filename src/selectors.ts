import { basename } from 'node:path';
import { UsageError } from './errors.js';
import type { AccountConfig, Provider } from './types.js';

export interface Selector {
  provider: Provider;
  label?: string;
  directoryName?: string;
}

export function parseSelector(value: string): Selector {
  if (value === 'codex' || value === 'claude') return { provider: value };
  const directory = /^\.(codex|claude)(?:-[a-z0-9_-]+)?$/.exec(value);
  if (directory) return { provider: directory[1] as Provider, directoryName: value };
  const match = /^(codex|claude):([a-z0-9_-]+)$/.exec(value);
  if (!match) {
    throw new UsageError('invalid_configuration', `Invalid account selector: ${value}`);
  }
  return { provider: match[1] as Provider, label: match[2] as string };
}

export function accountDirectoryName(account: AccountConfig): string {
  return account.directoryName ?? basename(account.stateDir);
}

export function selectAccounts(accounts: AccountConfig[], values: string[]): AccountConfig[] {
  if (!values.length) return [...accounts].sort(accountOrder);
  const selected = new Map<string, AccountConfig>();
  for (const value of values) {
    const directoryMatches =
      value === 'codex' || value === 'claude'
        ? []
        : accounts.filter((account) => accountDirectoryName(account) === value);
    let matches = directoryMatches;
    if (!matches.length) {
      const selector = parseSelector(value);
      matches = accounts.filter(
        (account) =>
          account.provider === selector.provider &&
          (selector.directoryName
            ? accountDirectoryName(account) === selector.directoryName
            : selector.label === undefined || account.label === selector.label),
      );
      // Accept the default alias without shadowing an explicitly labeled account.
      if (!matches.length && selector.label === 'default') {
        matches = accounts.filter(
          (account) =>
            account.provider === selector.provider &&
            accountDirectoryName(account) === `.${selector.provider}`,
        );
      }
      if (
        (selector.label !== undefined || selector.directoryName !== undefined) &&
        matches.length === 0
      ) {
        throw new UsageError('invalid_configuration', `Unknown account: ${value}`);
      }
    }
    for (const account of matches) selected.set(`${account.provider}:${account.label}`, account);
  }
  return [...selected.values()].sort(accountOrder);
}

export function accountOrder(
  a: Pick<AccountConfig, 'provider' | 'label'>,
  b: Pick<AccountConfig, 'provider' | 'label'>,
): number {
  return a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label);
}
