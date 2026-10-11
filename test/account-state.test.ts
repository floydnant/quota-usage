import {
  chmod,
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
import { afterEach, describe, expect, it } from 'vitest';
import { accountStateAvailable, inspectAccountDirectory } from '../src/account-state.js';
import { cachePath, writeCache } from '../src/cache.js';
import { collectUsage } from '../src/collect.js';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js';
import { discoverAccounts, existingAccounts } from '../src/discovery.js';
import { doctor } from '../src/doctor.js';
import { appPaths } from '../src/paths.js';
import { ProcessTracker } from '../src/processes.js';
import { ClaudeLiveAdapter } from '../src/providers/claude-live.js';
import { CodexAdapter } from '../src/providers/codex.js';
import type { AccountConfig, AccountResult, Provider } from '../src/types.js';

const homes: string[] = [];
async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'account-state-'));
  homes.push(home);
  return home;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const fixture = (provider: Provider, label: string): AccountResult => ({
  provider,
  label,
  source: 'fixture',
  status: 'live',
  collectedAt: '2026-10-11T10:00:00Z',
  windows: [{ id: '5h', usedPercent: 12, remainingPercent: 88 }],
});

async function fakeVendor(home: string, provider: Provider, body: string) {
  const executable = join(home, `fake-${provider}`);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = ${JSON.stringify(home)};
const stateDir = process.env.${provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'};
const version = ${JSON.stringify(provider === 'codex' ? 'codex-cli 0.150.1' : '2.1.250 (Claude Code)')};
${body}
`,
  );
  await chmod(executable, 0o700);
  return executable;
}

describe('account directory state', () => {
  it.each([true, false])(
    'doctor skips missing account state with discovery=%s',
    async (discover) => {
      const home = await temporaryHome();
      const executables = {} as Record<'codexExecutable' | 'claudeExecutable', string>;
      for (const provider of ['codex', 'claude'] as const) {
        executables[`${provider}Executable`] = await fakeVendor(
          home,
          provider,
          `
if (process.argv.includes('--version')) { console.log(version); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--stdio'); process.exit(0); }
fs.writeFileSync(path.join(home, 'login-called'), 'called');
fs.mkdirSync(stateDir, { recursive: true });
`,
        );
      }
      const store = new ConfigStore(appPaths(home));
      await store.write({
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, ...executables },
        accounts: ['codex', 'claude'].map((provider) => ({
          provider: provider as Provider,
          label: 'missing',
          stateDir: join(home, `.${provider}-missing`),
          ownership: 'external',
        })),
      });
      const checks = await doctor(store, { discover });
      expect(checks.some((check) => check.name.endsWith(' login'))).toBe(false);
      await expect(readFile(join(home, 'login-called'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await inspectAccountDirectory(join(home, '.claude-missing'))).toBeUndefined();
      expect(await inspectAccountDirectory(join(home, '.codex-missing'))).toBeUndefined();
    },
  );
  it('excludes absent registrations, files, and broken links without rewriting configuration', async () => {
    const home = await temporaryHome();
    const store = new ConfigStore(appPaths(home));
    await mkdir(join(home, '.codex-work'));
    await mkdir(join(home, 'existing'));
    await writeFile(join(home, 'file'), 'not a directory');
    await symlink(join(home, 'missing'), join(home, 'broken'));
    const accounts: AccountConfig[] = ['missing', 'file', 'file/child', 'broken', 'existing'].map(
      (name, index) => ({
        provider: 'codex',
        label: index === 0 ? 'work' : name.replace('/', '-'),
        stateDir: join(home, name),
        ownership: 'external',
      }),
    );
    await store.write({ ...DEFAULT_CONFIG, accounts });
    const before = await readFile(store.paths.configFile, 'utf8');
    for (const discover of [true, false]) {
      const inventory = await discoverAccounts(accounts, home, discover);
      expect(inventory.errors).toEqual([]);
      // The absent explicit work label still reserves its collision with .codex-work.
      expect(inventory.accounts.map((account) => account.label)).toEqual(['existing']);
    }
    expect(await readFile(store.paths.configFile, 'utf8')).toBe(before);
    expect(await inspectAccountDirectory(join(home, 'file/child'))).toBeUndefined();
  });

  it('reports inspection failures safely while preserving other accounts', async () => {
    const home = await temporaryHome();
    await symlink(join(home, 'loop'), join(home, 'loop'));
    const bad: AccountConfig = {
      provider: 'claude',
      label: 'bad',
      stateDir: join(home, 'loop'),
      ownership: 'external',
    };
    const good: AccountConfig = { ...bad, label: 'good', stateDir: home };
    const inventory = await existingAccounts([bad, good]);
    expect(inventory.accounts).toEqual([good]);
    expect(inventory.errors).toMatchObject([
      { code: 'invalid_configuration', accountLabel: 'bad' },
    ]);
  });

  it('invalidates a discovered entry when its alias is removed/retargeted or directory is replaced', async () => {
    const home = await temporaryHome();
    const target = join(home, 'target');
    const alias = join(home, '.claude-work');
    await mkdir(target);
    await mkdir(join(home, 'other'));
    await symlink(target, alias);
    const account = (await discoverAccounts([], home)).accounts[0] as AccountConfig;
    expect(await accountStateAvailable(account)).toBe(true);
    await rm(alias);
    expect(await accountStateAvailable(account)).toBe(false);
    await symlink(join(home, 'other'), alias);
    expect(await accountStateAvailable(account)).toBe(false);
    await rm(alias);
    await symlink(target, alias);
    await rename(target, join(home, 'old'));
    await mkdir(target);
    expect(await accountStateAvailable(account)).toBe(false);
  });

  it.each(['codex', 'claude'] as const)(
    'does not resurrect a deleted %s registration from cache or live refreshes',
    async (provider) => {
      const home = await temporaryHome();
      const paths = appPaths(home);
      const stateDir = join(home, `.${provider}-work`);
      await mkdir(stateDir);
      const account: AccountConfig = {
        provider,
        label: 'work',
        stateDir: await realpath(stateDir),
        ownership: 'external',
      };
      const executable = await fakeVendor(
        home,
        provider,
        `fs.writeFileSync(path.join(home, 'called'), 'called'); fs.mkdirSync(path.join(home, '.${provider}-work'), { recursive: true }); process.exit(1);`,
      );
      const config = {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, [`${provider}Executable`]: executable },
        accounts: [account],
      };
      await writeCache(paths, fixture(provider, 'work'));
      expect(
        (await collectUsage({ config, paths, selectors: [], mode: 'cached' })).results,
      ).toHaveLength(1);
      await rm(stateDir, { recursive: true });
      for (const discover of [true, false]) {
        for (const mode of ['default', 'cached', 'default'] as const) {
          expect(await collectUsage({ config, paths, selectors: [], mode, discover })).toEqual({
            results: [],
            errors: [],
            exitCode: 0,
          });
        }
      }
      await expect(readFile(join(home, 'called'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await inspectAccountDirectory(stateDir)).toBeUndefined();
    },
  );

  it.each(['codex', 'claude'] as const)(
    'rechecks %s state after version lookup and before retrying',
    async (provider) => {
      for (const phase of ['version', 'retry'] as const) {
        const home = await temporaryHome();
        const stateDir = join(home, `.${provider}-work`);
        await mkdir(stateDir);
        const executable = await fakeVendor(
          home,
          provider,
          `
if (process.argv.includes('--version')) {
  if (${JSON.stringify(phase)} === 'version') fs.rmSync(path.join(home, '.${provider}-work'), { recursive: true });
  console.log(version); process.exit(0);
}
fs.appendFileSync(path.join(home, 'calls'), 'call\\n');
fs.mkdirSync(stateDir, { recursive: true });
fs.rmSync(stateDir, { recursive: true });
${provider === 'codex' ? 'process.exit(1);' : 'console.log(JSON.stringify({ is_error: false }));'}
`,
        );
        const tracker = new ProcessTracker();
        const adapter =
          provider === 'codex'
            ? new CodexAdapter(executable, tracker)
            : new ClaudeLiveAdapter(executable, tracker);
        await expect(
          adapter.collect(
            { provider, label: 'work', stateDir, ownership: 'external' },
            { timeoutMs: 1000 },
          ),
        ).rejects.toMatchObject({ data: { code: 'invalid_configuration', retryable: false } });
        const calls = await readFile(join(home, 'calls'), 'utf8').catch(() => '');
        expect(calls).toBe(phase === 'version' ? '' : 'call\n');
        expect(tracker.size).toBe(0);
        expect(await inspectAccountDirectory(stateDir)).toBeUndefined();
      }
    },
  );

  it('skips deleted queued Claude accounts and drops results deleted during collection', async () => {
    const home = await temporaryHome();
    const paths = appPaths(home);
    for (const label of ['a', 'b', 'keep']) await mkdir(join(home, `.claude-${label}`));
    const inventory = await discoverAccounts([], home);
    const removed = inventory.accounts.find((account) => account.label === 'a') as AccountConfig;
    await writeCache(paths, fixture('claude', 'a'), removed.discoveryKey);
    const cachedBefore = await readFile(
      cachePath(paths, 'claude', 'a', removed.discoveryKey),
      'utf8',
    );
    const executable = await fakeVendor(
      home,
      'claude',
      `
if (process.argv.includes('--version')) { console.log(version); process.exit(0); }
fs.appendFileSync(path.join(home, 'calls'), path.basename(stateDir) + '\\n');
fs.mkdirSync(stateDir, { recursive: true });
if (stateDir.endsWith('-a')) {
  fs.rmSync(stateDir, { recursive: true });
  fs.rmSync(path.join(home, '.claude-b'), { recursive: true });
}
console.log(JSON.stringify({ is_error: false, result: 'Current session: 12% used · resets in 1h' }));
`,
    );
    const request = {
      config: {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, claudeExecutable: executable },
      },
      paths,
      selectors: [],
      mode: 'default' as const,
    };
    const summary = await collectUsage(request);
    expect(summary).toMatchObject({
      exitCode: 0,
      errors: [],
      results: [{ label: 'keep', status: 'live' }],
    });
    expect(summary.results).toHaveLength(1);
    expect(await readFile(join(home, 'calls'), 'utf8')).toBe('.claude-a\n.claude-keep\n');
    expect(await readFile(cachePath(paths, 'claude', 'a', removed.discoveryKey), 'utf8')).toBe(
      cachedBefore,
    );
    expect((await collectUsage(request)).results.map((result) => result.label)).toEqual(['keep']);
    expect(await inspectAccountDirectory(join(home, '.claude-b'))).toBeUndefined();
  });
});
