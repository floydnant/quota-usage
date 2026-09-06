import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js';
import { discoverAccounts, loadAccountConfig } from '../src/discovery.js';
import { appPaths } from '../src/paths.js';
import type { AccountConfig } from '../src/types.js';

const temporaryHome = () => mkdtemp(join(tmpdir(), 'usage-discovery-'));

describe('directory inventory', () => {
  it('finds immediate provider directories without requiring registration or login files', async () => {
    const home = await temporaryHome();
    for (const name of [
      '.codex-work',
      '.claude-personal',
      '.codex',
      '.claude',
      '.other-work',
      '.codex-',
      '.codex-Upper',
      '.codex-work.bak',
      'nested/.codex-hidden',
    ]) {
      await mkdir(join(home, name), { recursive: true });
    }
    await writeFile(join(home, '.claude-file'), 'not a directory');
    const inventory = await discoverAccounts([], home);
    expect(inventory.errors).toEqual([]);
    expect(inventory.accounts.map((account) => `${account.provider}:${account.label}`)).toEqual([
      'claude:default',
      'claude:personal',
      'codex:default',
      'codex:work',
    ]);
    expect(inventory.accounts[0]).toMatchObject({ ownership: 'external' });
    expect(inventory.accounts[0]).toHaveProperty('claudeDefault', true);
    expect(inventory.accounts[1]).not.toHaveProperty('claudeDefault');
    expect(inventory.accounts[0]?.discoveryKey).toMatch(/^[a-f0-9]{64}$/);
    const store = new ConfigStore(appPaths(home));
    expect(await loadAccountConfig(store)).toEqual(DEFAULT_CONFIG);
    expect(await store.exists()).toBe(false);
  });

  it('preserves explicit labels, arbitrary paths, and Claude default mode; deduplicates canonical paths', async () => {
    const home = await temporaryHome();
    const arbitrary = join(home, 'arbitrary');
    await mkdir(arbitrary);
    await mkdir(join(home, '.codex-work'));
    await mkdir(join(home, '.claude-work'));
    await symlink(arbitrary, join(home, '.codex-alias'));
    const registered: AccountConfig[] = [
      {
        provider: 'codex',
        label: 'work',
        stateDir: arbitrary,
        ownership: 'external',
        identityHash: 'pinned',
      },
      {
        provider: 'claude',
        label: 'default',
        stateDir: join(home, '.claude'),
        ownership: 'external',
        claudeDefault: true,
      },
    ];
    const inventory = await discoverAccounts(registered, home);
    expect(inventory.accounts).toHaveLength(3);
    expect(inventory.accounts.find((account) => account.provider === 'codex')).toEqual(
      registered[0],
    );
    expect(inventory.accounts.find((account) => account.label === 'default')).toEqual(
      registered[1],
    );
    expect(registered).toHaveLength(2);
  });

  it('follows directory aliases once, ignores broken/file aliases, and tracks additions/removals', async () => {
    const home = await temporaryHome();
    const target = join(home, 'target');
    await mkdir(target);
    await writeFile(join(home, 'file'), 'file');
    await symlink(target, join(home, '.codex-a'));
    await symlink(target, join(home, '.codex-b'));
    await symlink(join(home, 'missing'), join(home, '.claude-broken'));
    await symlink(join(home, 'file'), join(home, '.claude-file'));
    const first = await discoverAccounts([], home);
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]?.stateDir).toBe(await realpath(target));
    expect((await discoverAccounts([], home)).accounts).toEqual(first.accounts);
    await rm(join(home, '.codex-a'));
    await rm(join(home, '.codex-b'));
    await mkdir(join(home, '.claude-new'));
    expect((await discoverAccounts([], home)).accounts.map((account) => account.label)).toEqual([
      'new',
    ]);
  });

  it('changes the cache namespace when a directory is replaced or an alias is retargeted', async () => {
    const home = await temporaryHome();
    const dir = join(home, '.codex-work');
    await mkdir(dir);
    const first = (await discoverAccounts([], home)).accounts[0];
    await rename(dir, join(home, 'old'));
    await mkdir(dir);
    const second = (await discoverAccounts([], home)).accounts[0];
    expect(second?.discoveryKey).not.toBe(first?.discoveryKey);
    await rm(dir, { recursive: true });
    await symlink(join(home, 'old'), dir);
    expect((await discoverAccounts([], home)).accounts[0]?.discoveryKey).not.toBe(
      second?.discoveryKey,
    );
  });

  it('retains configured accounts when home cannot be scanned', async () => {
    const home = await temporaryHome();
    const registered: AccountConfig[] = [
      { provider: 'codex', label: 'work', stateDir: home, ownership: 'external' },
    ];
    const inventory = await discoverAccounts(registered, join(home, 'missing'));
    expect(inventory.accounts).toEqual(registered);
    expect(inventory.errors).toMatchObject([{ code: 'invalid_configuration' }]);
  });

  it('loads explicit configuration unchanged and rejects malformed configuration', async () => {
    const store = new ConfigStore(appPaths(await temporaryHome()));
    await store.write(DEFAULT_CONFIG);
    const before = await readFile(store.paths.configFile, 'utf8');
    expect(await loadAccountConfig(store)).toEqual(DEFAULT_CONFIG);
    expect(await readFile(store.paths.configFile, 'utf8')).toBe(before);
    await writeFile(store.paths.configFile, 'schemaVersion: 1\nunexpected: true\n');
    await expect(loadAccountConfig(store)).rejects.toThrow('unexpected');
  });
});

it('rediscovers the default directory after removing its explicit registration', async () => {
  const home = await temporaryHome();
  await mkdir(join(home, '.codex'));
  const stateDir = await realpath(join(home, '.codex'));
  const registered: AccountConfig = {
    provider: 'codex',
    label: 'personal',
    stateDir,
    ownership: 'external',
  };
  expect((await discoverAccounts([registered], home)).accounts).toEqual([registered]);
  expect((await discoverAccounts([], home)).accounts).toMatchObject([
    {
      provider: 'codex',
      label: 'default',
      directoryName: '.codex',
      stateDir,
      ownership: 'external',
    },
  ]);
});
