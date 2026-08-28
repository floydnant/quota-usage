import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addAccount,
  collectorPaths,
  installClaudeCollector,
  removeAccount,
  restoreClaudeCollector,
} from '../src/accounts.js';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js';
import { appPaths } from '../src/paths.js';
import type { AccountConfig, UsageConfig } from '../src/types.js';

async function setup(): Promise<ConfigStore> {
  const home = await mkdtemp(join(tmpdir(), 'accounts-'));
  return new ConfigStore(appPaths(await realpath(home)));
}

async function statusLineCommand(path: string): Promise<unknown> {
  const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  return (settings.statusLine as Record<string, unknown> | undefined)?.command;
}

describe('Claude collector configuration', () => {
  it('previews, installs, records prior settings, and restores safely', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'claude-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: '/bin/cat' }, theme: 'dark' }),
    );
    const account: AccountConfig = {
      provider: 'claude',
      label: 'work',
      stateDir,
      ownership: 'external',
    };
    let preview = '';
    const installed = await installClaudeCollector(account, store, async (message) => {
      preview = message;
      return true;
    });
    expect(preview).toContain('/bin/cat');
    expect(installed.claudeCollector?.previousStatusLine).toMatchObject({ command: '/bin/cat' });
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe(
      installed.claudeCollector?.wrapperCommand,
    );
    expect((await lstat(collectorPaths(store, 'work').helper)).mode & 0o777).toBe(0o700);
    expect(await restoreClaudeCollector(installed)).toEqual({ restored: true });
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe('/bin/cat');
  });

  it('detects drift and refuses to overwrite newer settings', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'claude-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'newer' } }),
    );
    const account: AccountConfig = {
      provider: 'claude',
      label: 'work',
      stateDir,
      ownership: 'external',
      claudeCollector: {
        wrapperCommand: 'usage wrapper',
        previousStatusLine: { type: 'command', command: 'old' },
      },
    };
    const result = await restoreClaudeCollector(account);
    expect(result.restored).toBe(false);
    expect(result.drift).toContain('manually');
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe('newer');
  });
});

describe('account registration', () => {
  it('canonicalizes existing Codex state and stores only a hashed identity', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'codex-real');
    const linkedState = join(store.paths.dataDir, 'codex-link');
    await mkdir(stateDir, { recursive: true });
    await symlink(stateDir, linkedState);
    const fake = join(store.paths.dataDir, 'fake-codex');
    await writeFile(
      fake,
      `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.150.1');process.exit(0)}
const r=require('node:readline').createInterface({input:process.stdin});
r.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='account/read')console.log(JSON.stringify({id:m.id,result:{account:{type:'chatgpt',email:'user@example.com',planType:'plus'}}}))});`,
    );
    await chmod(fake, 0o700);
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
      },
      false,
    );
    const account = await addAccount(store, 'codex', 'personal', {
      stateDir: linkedState,
      confirm: async () => true,
    });
    expect(account.stateDir).toBe(stateDir);
    expect(account.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(store.paths.configFile, 'utf8')).not.toContain('user@example.com');
  });

  it('validates Claude through the official CLI and installs its collector', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'claude-state');
    await mkdir(stateDir, { recursive: true });
    const fake = join(store.paths.dataDir, 'fake-claude');
    await writeFile(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.238 (Claude Code)'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 1
`,
    );
    await chmod(fake, 0o700);
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, claudeExecutable: fake },
      },
      false,
    );
    const account = await addAccount(store, 'claude', 'work', {
      stateDir,
      confirm: async () => true,
    });
    expect(account.claudeCollector?.wrapperCommand).toContain('claude-statusline');
    expect(await statusLineCommand(join(stateDir, 'settings.json'))).toBe(
      account.claudeCollector?.wrapperCommand,
    );
  });
});

describe('removal and purge guards', () => {
  it('normal removal leaves external vendor state untouched', async () => {
    const store = await setup();
    const stateDir = join(store.paths.dataDir, 'external');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'keep'), 'credentials belong to vendor');
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'external',
    };
    await store.write({ ...DEFAULT_CONFIG, accounts: [account] }, false);
    const result = await removeAccount(store, 'codex:personal', { confirm: async () => true });
    expect(result.messages.join(' ')).toContain('credentials were left untouched');
    expect(await readFile(join(stateDir, 'keep'), 'utf8')).toContain('vendor');
    expect((await store.load()).accounts).toHaveLength(0);
  });

  it('refuses purge for external, symlinked, and mismatched marker targets', async () => {
    const store = await setup();
    const external: AccountConfig = {
      provider: 'codex',
      label: 'x',
      stateDir: join(store.paths.dataDir, 'x'),
      ownership: 'external',
    };
    await mkdir(external.stateDir, { recursive: true });
    await store.write({ ...DEFAULT_CONFIG, accounts: [external] }, false);
    await expect(
      removeAccount(store, 'codex:x', { purge: true, confirm: async () => true }),
    ).rejects.toThrow('Only managed');

    const real = join(store.paths.dataDir, 'real');
    const target = join(store.paths.managedRoot, 'codex', 'x');
    await mkdir(real, { recursive: true });
    await mkdir(join(store.paths.managedRoot, 'codex'), { recursive: true });
    await symlink(real, target);
    const managed: AccountConfig = {
      ...external,
      stateDir: target,
      ownership: 'managed',
      ownershipMarker: 'expected',
    };
    await store.write({ ...DEFAULT_CONFIG, accounts: [managed] });
    await expect(
      removeAccount(store, 'codex:x', { purge: true, confirm: async () => true }),
    ).rejects.toThrow('missing or unsafe');
  });

  it('logs out through the vendor then moves verified managed state to Trash', async () => {
    const store = await setup();
    const stateDir = join(store.paths.managedRoot, 'codex', 'personal');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, '.usage-owner'), JSON.stringify({ id: 'marker' }), {
      mode: 0o600,
    });
    const fake = join(store.paths.dataDir, 'codex');
    await writeFile(fake, '#!/bin/sh\nexit 0\n');
    await chmod(fake, 0o700);
    const account: AccountConfig = {
      provider: 'codex',
      label: 'personal',
      stateDir,
      ownership: 'managed',
      ownershipMarker: 'marker',
    };
    const config: UsageConfig = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: fake },
      accounts: [account],
    };
    await store.write(config, false);
    const result = await removeAccount(store, 'codex:personal', {
      purge: true,
      confirm: async () => true,
    });
    expect(result.messages.join(' ')).toContain('recoverable from Trash');
    expect(
      await lstat(stateDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
