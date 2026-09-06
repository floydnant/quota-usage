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

it('accepts directory names and keeps colon/default aliases without shadowing explicit labels', () => {
  const detected: AccountConfig[] = [
    {
      provider: 'codex',
      label: 'default',
      directoryName: '.codex',
      stateDir: '/home/.codex',
      ownership: 'external',
    },
    {
      provider: 'codex',
      label: 'work',
      directoryName: '.codex-work',
      stateDir: '/elsewhere/state',
      ownership: 'external',
    },
    {
      provider: 'claude',
      label: 'client',
      stateDir: '/elsewhere/client-state',
      ownership: 'external',
    },
  ];
  expect(parseSelector('.codex')).toEqual({ provider: 'codex', directoryName: '.codex' });
  expect(
    selectAccounts(detected, ['.codex', 'codex:default']).map((account) => account.label),
  ).toEqual(['default']);
  expect(
    selectAccounts(detected, ['.codex-work', 'codex:work']).map((account) => account.label),
  ).toEqual(['work']);
  expect(
    selectAccounts(detected, ['client-state', 'claude:client']).map((account) => account.label),
  ).toEqual(['client']);
  expect(selectAccounts(detected, ['codex'])).toHaveLength(2);
  expect(() => selectAccounts(detected, ['.claude-missing'])).toThrow('Unknown account');
  expect(() => selectAccounts(detected, ['codex:personal'])).toThrow('Unknown account');
  const explicit: AccountConfig = {
    provider: 'codex',
    label: 'personal',
    stateDir: '/arbitrary',
    ownership: 'external',
  };
  expect(selectAccounts([...detected, explicit], ['codex:personal'])).toEqual([explicit]);
});
