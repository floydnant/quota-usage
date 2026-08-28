import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigStore,
  DEFAULT_CONFIG,
  findAccount,
  validateConfig,
  validateLabel,
} from '../src/config.js';
import { appPaths } from '../src/paths.js';

async function store(): Promise<ConfigStore> {
  const home = await mkdtemp(join(tmpdir(), 'quota-config-'));
  return new ConfigStore(appPaths(home));
}

describe('configuration', () => {
  it('creates owner-only YAML and keeps one backup', async () => {
    const config = await store();
    await config.write(DEFAULT_CONFIG, false);
    await writeFile(
      config.paths.configFile,
      `# keep me\n${await readFile(config.paths.configFile, 'utf8')}`,
    );
    await config.write({
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, codexTimeout: '1m' },
    });
    expect(await config.load()).toMatchObject({ defaults: { codexTimeout: '1m' } });
    expect(await readFile(config.paths.configFile, 'utf8')).toContain('# keep me');
    expect(await readFile(config.paths.backupFile, 'utf8')).toContain('# keep me');
    expect((await stat(config.paths.configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(config.paths.configDir)).mode & 0o777).toBe(0o700);
  });

  it('reports unknown YAML paths', () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, surprise: true })).toThrow('config.surprise');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [
          { provider: 'codex', label: 'one', stateDir: '/tmp/one', ownership: 'external', bad: 1 },
        ],
      }),
    ).toThrow('config.accounts[0].bad');
  });

  it('rejects malformed durations, duplicate labels, duplicate state, and uppercase labels', () => {
    expect(() => validateLabel('Personal')).toThrow('Invalid account label');
    expect(() => validateLabel('ok-name_1')).not.toThrow();
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, staleAfter: 'soon' },
      }),
    ).toThrow('Invalid duration');
    const one = { provider: 'claude', label: 'a', stateDir: '/tmp/a', ownership: 'external' };
    expect(() => validateConfig({ ...DEFAULT_CONFIG, accounts: [one, one] })).toThrow(
      'Duplicate account label',
    );
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, accounts: [one, { ...one, label: 'b' }] }),
    ).toThrow('same state directory');
  });

  it('requires managed markers and absolute paths', () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [{ provider: 'codex', label: 'a', stateDir: 'relative', ownership: 'external' }],
      }),
    ).toThrow('must be absolute');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [{ provider: 'codex', label: 'a', stateDir: '/tmp/a', ownership: 'managed' }],
      }),
    ).toThrow('ownershipMarker');
  });

  it('covers complete optional account metadata and rejects invalid shapes', () => {
    const complete = validateConfig({
      schemaVersion: 1,
      defaults: {
        codexTimeout: '10s',
        claudeTimeout: '30s',
        staleAfter: '15m',
        codexExecutable: '/bin/codex',
        claudeExecutable: '/bin/claude',
      },
      accounts: [
        {
          provider: 'codex',
          label: 'one',
          stateDir: '/tmp/one',
          ownership: 'managed',
          ownershipMarker: 'marker',
          identityHash: 'hash',
          identityMetadata: { maskedEmail: 'u***@example.com', plan: 'plus' },
        },
        {
          provider: 'claude',
          label: 'two',
          stateDir: '/tmp/two',
          ownership: 'external',
          claudeCollector: { wrapperCommand: 'wrapper', previousStatusLine: { command: 'old' } },
        },
        {
          provider: 'claude',
          label: 'three',
          stateDir: '/tmp/three',
          ownership: 'external',
          identityMetadata: {},
          claudeCollector: { wrapperCommand: 'wrapper' },
        },
      ],
    });
    expect(complete.accounts[0]).toMatchObject({ identityHash: 'hash', ownershipMarker: 'marker' });
    expect(complete.accounts[1]?.claudeCollector?.previousStatusLine).toEqual({ command: 'old' });
    expect(() => validateConfig(null)).toThrow('must be a mapping');
    expect(() => validateConfig({ ...DEFAULT_CONFIG, schemaVersion: 2 })).toThrow('schemaVersion');
    expect(() => validateConfig({ ...DEFAULT_CONFIG, accounts: {} })).toThrow('must be a sequence');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [{ provider: 'other', label: 'x', stateDir: '/x', ownership: 'external' }],
      }),
    ).toThrow('provider must be');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [{ provider: 'codex', label: 'x', stateDir: '/x', ownership: 'wrong' }],
      }),
    ).toThrow('ownership must be');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [
          {
            provider: 'codex',
            label: 'x',
            stateDir: '/x',
            ownership: 'external',
            identityMetadata: { extra: true },
          },
        ],
      }),
    ).toThrow('identityMetadata.extra');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        accounts: [
          {
            provider: 'claude',
            label: 'x',
            stateDir: '/x',
            ownership: 'external',
            claudeCollector: { wrapperCommand: 'x', extra: true },
          },
        ],
      }),
    ).toThrow('claudeCollector.extra');
  });

  it('handles missing creation, missing errors, invalid YAML, scalar documents, and account lookup', async () => {
    const config = await store();
    await expect(config.load()).rejects.toThrow('Configuration not found');
    expect(await config.load({ create: true })).toEqual(DEFAULT_CONFIG);
    expect(
      findAccount(
        {
          ...DEFAULT_CONFIG,
          accounts: [{ provider: 'codex', label: 'x', stateDir: '/x', ownership: 'external' }],
        },
        'codex',
        'x',
      ).label,
    ).toBe('x');
    expect(() => findAccount(DEFAULT_CONFIG, 'codex', 'x')).toThrow('Unknown account');
    await writeFile(config.paths.configFile, ': invalid: [');
    await expect(config.load()).rejects.toThrow();
    await writeFile(config.paths.configFile, 'scalar\n');
    await config.write(DEFAULT_CONFIG);
    expect(await config.load()).toEqual(DEFAULT_CONFIG);
  });
});
