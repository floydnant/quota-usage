import { UsageError } from './errors.js';
import type { AccountConfig, Provider } from './types.js';

export interface Selector {
  provider: Provider;
  label?: string;
}

export function parseSelector(value: string): Selector {
  if (value === 'codex' || value === 'claude') return { provider: value };
  const match = /^(codex|claude):([a-z0-9_-]+)$/.exec(value);
  if (!match) {
    throw new UsageError('invalid_configuration', `Invalid account selector: ${value}`);
  }
  return { provider: match[1] as Provider, label: match[2] as string };
}

export function selectAccounts(accounts: AccountConfig[], values: string[]): AccountConfig[] {
  if (!values.length) return [...accounts].sort(accountOrder);
  const selected = new Map<string, AccountConfig>();
  for (const value of values) {
    const selector = parseSelector(value);
    const matches = accounts.filter(
      (account) =>
        account.provider === selector.provider &&
        (selector.label === undefined || account.label === selector.label),
    );
    if (selector.label !== undefined && matches.length === 0) {
      throw new UsageError('invalid_configuration', `Unknown account: ${value}`);
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
