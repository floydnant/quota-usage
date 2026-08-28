import { describe, expect, it } from 'vitest';
import { parseSelector, selectAccounts } from '../src/selectors.js';
import type { AccountConfig } from '../src/types.js';

const accounts: AccountConfig[] = [
  { provider: 'claude', label: 'work', stateDir: '/c', ownership: 'external' },
  { provider: 'codex', label: 'personal', stateDir: '/a', ownership: 'external' },
  { provider: 'codex', label: 'work', stateDir: '/b', ownership: 'external' },
];

describe('selectors', () => {
  it('parses provider and account selectors', () => {
    expect(parseSelector('codex')).toEqual({ provider: 'codex' });
    expect(parseSelector('claude:work')).toEqual({ provider: 'claude', label: 'work' });
    expect(() => parseSelector('Codex:work')).toThrow('Invalid account selector');
  });

  it('selects all by default and deduplicates overlaps', () => {
    expect(selectAccounts(accounts, []).map((a) => `${a.provider}:${a.label}`)).toEqual([
      'claude:work',
      'codex:personal',
      'codex:work',
    ]);
    expect(selectAccounts(accounts, ['codex', 'codex:personal']).map((a) => a.label)).toEqual([
      'personal',
      'work',
    ]);
  });

  it('rejects unknown explicit accounts but permits providers with no accounts', () => {
    expect(() => selectAccounts(accounts, ['claude:missing'])).toThrow('Unknown account');
    expect(
      selectAccounts(
        accounts.filter((a) => a.provider === 'codex'),
        ['claude'],
      ),
    ).toEqual([]);
  });
});
