import { constants } from 'node:fs';
import { access, chmod, copyFile, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Document, isMap, parseDocument } from 'yaml';
import { UsageError } from './errors.js';
import { appPaths, defaultStateDir, ensurePrivateDir, type AppPaths } from './paths.js';
import { parseDuration } from './duration.js';
import type { AccountConfig, Provider, UsageConfig } from './types.js';

export const DEFAULT_CONFIG: UsageConfig = {
  schemaVersion: 1,
  defaults: {
    codexTimeout: '10s',
    claudeTimeout: '30s',
    staleAfter: '15m',
  },
  accounts: [],
};

const TOP_FIELDS = new Set(['schemaVersion', 'defaults', 'accounts']);
const DEFAULT_FIELDS = new Set([
  'codexTimeout',
  'claudeTimeout',
  'staleAfter',
  'codexExecutable',
  'claudeExecutable',
]);
const ACCOUNT_FIELDS = new Set([
  'provider',
  'label',
  'stateDir',
  'ownership',
  'claudeDefault',
  'ownershipMarker',
  'identityHash',
  'identityMetadata',
  'claudeCollector',
]);
const IDENTITY_FIELDS = new Set(['maskedEmail', 'plan']);
const COLLECTOR_FIELDS = new Set(['wrapperCommand', 'previousStatusLine']);

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('invalid_configuration', `${path} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(object: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new UsageError('invalid_configuration', `Unknown configuration field: ${path}.${key}`, {
        details: { path: `${path}.${key}` },
      });
    }
  }
}

function stringAt(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError('invalid_configuration', `${path}.${key} must be a non-empty string`);
  }
  return value;
}

export function validateLabel(label: string): void {
  if (!/^[a-z0-9_-]+$/.test(label)) {
    throw new UsageError(
      'invalid_configuration',
      `Invalid account label "${label}"; use lowercase ASCII letters, digits, underscores, or hyphens`,
    );
  }
}

export function validateConfig(value: unknown): UsageConfig {
  const root = objectAt(value, 'config');
  rejectUnknown(root, TOP_FIELDS, 'config');
  if (root.schemaVersion !== 1) {
    throw new UsageError('invalid_configuration', 'config.schemaVersion must be 1');
  }
  const defaults = objectAt(root.defaults, 'config.defaults');
  rejectUnknown(defaults, DEFAULT_FIELDS, 'config.defaults');
  const codexTimeout = stringAt(defaults, 'codexTimeout', 'config.defaults');
  const claudeTimeout = stringAt(defaults, 'claudeTimeout', 'config.defaults');
  const staleAfter = stringAt(defaults, 'staleAfter', 'config.defaults');
  parseDuration(codexTimeout);
  parseDuration(claudeTimeout);
  parseDuration(staleAfter);
  if (!Array.isArray(root.accounts)) {
    throw new UsageError('invalid_configuration', 'config.accounts must be a sequence');
  }
  const accounts: AccountConfig[] = [];
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const [index, raw] of root.accounts.entries()) {
    const path = `config.accounts[${index}]`;
    const item = objectAt(raw, path);
    rejectUnknown(item, ACCOUNT_FIELDS, path);
    const provider = stringAt(item, 'provider', path);
    if (provider !== 'codex' && provider !== 'claude') {
      throw new UsageError('invalid_configuration', `${path}.provider must be codex or claude`);
    }
    const label = stringAt(item, 'label', path);
    validateLabel(label);
    const stateDir = stringAt(item, 'stateDir', path);
    if (!stateDir.startsWith('/')) {
      throw new UsageError('invalid_configuration', `${path}.stateDir must be absolute`);
    }
    const ownership = stringAt(item, 'ownership', path);
    if (ownership !== 'external' && ownership !== 'managed') {
      throw new UsageError(
        'invalid_configuration',
        `${path}.ownership must be external or managed`,
      );
    }
    if (ownership === 'managed' && typeof item.ownershipMarker !== 'string') {
      throw new UsageError(
        'invalid_configuration',
        `${path}.ownershipMarker is required for managed state`,
      );
    }
    if (
      item.claudeDefault !== undefined &&
      (provider !== 'claude' || ownership !== 'external' || typeof item.claudeDefault !== 'boolean')
    ) {
      throw new UsageError(
        'invalid_configuration',
        `${path}.claudeDefault is valid only as a boolean on an external Claude account`,
      );
    }
    const key = `${provider}:${label}`;
    if (identities.has(key)) {
      throw new UsageError('invalid_configuration', `Duplicate account label: ${key}`);
    }
    identities.add(key);
    const pathKey = `${provider}:${stateDir}`;
    if (paths.has(pathKey)) {
      throw new UsageError(
        'invalid_configuration',
        `Two ${provider} accounts use the same state directory: ${stateDir}`,
      );
    }
    paths.add(pathKey);

    let identityMetadata: AccountConfig['identityMetadata'];
    if (item.identityMetadata !== undefined) {
      const metadata = objectAt(item.identityMetadata, `${path}.identityMetadata`);
      rejectUnknown(metadata, IDENTITY_FIELDS, `${path}.identityMetadata`);
      identityMetadata = {
        ...(typeof metadata.maskedEmail === 'string' ? { maskedEmail: metadata.maskedEmail } : {}),
        ...(typeof metadata.plan === 'string' ? { plan: metadata.plan } : {}),
      };
    }
    let claudeCollector: AccountConfig['claudeCollector'];
    if (item.claudeCollector !== undefined) {
      const collector = objectAt(item.claudeCollector, `${path}.claudeCollector`);
      rejectUnknown(collector, COLLECTOR_FIELDS, `${path}.claudeCollector`);
      claudeCollector = {
        wrapperCommand: stringAt(collector, 'wrapperCommand', `${path}.claudeCollector`),
        ...(collector.previousStatusLine === undefined
          ? {}
          : { previousStatusLine: collector.previousStatusLine }),
      };
    }
    accounts.push({
      provider,
      label,
      stateDir,
      ownership,
      ...(provider === 'claude' && item.claudeDefault === true
        ? { claudeDefault: true }
        : provider === 'claude' &&
            ownership === 'external' &&
            stateDir === defaultStateDir('claude', {})
          ? { claudeDefault: true }
          : {}),
      ...(typeof item.ownershipMarker === 'string'
        ? { ownershipMarker: item.ownershipMarker }
        : {}),
      ...(typeof item.identityHash === 'string' ? { identityHash: item.identityHash } : {}),
      ...(identityMetadata === undefined ? {} : { identityMetadata }),
      ...(claudeCollector === undefined ? {} : { claudeCollector }),
    });
  }
  return {
    schemaVersion: 1,
    defaults: {
      codexTimeout,
      claudeTimeout,
      staleAfter,
      ...(typeof defaults.codexExecutable === 'string'
        ? { codexExecutable: defaults.codexExecutable }
        : {}),
      ...(typeof defaults.claudeExecutable === 'string'
        ? { claudeExecutable: defaults.claudeExecutable }
        : {}),
    },
    accounts,
  };
}

async function atomicText(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
}

export class ConfigStore {
  constructor(readonly paths: AppPaths = appPaths()) {}

  async exists(): Promise<boolean> {
    return access(this.paths.configFile, constants.F_OK).then(
      () => true,
      () => false,
    );
  }

  async load(options: { create?: boolean } = {}): Promise<UsageConfig> {
    if (!(await this.exists())) {
      if (!options.create) {
        throw new UsageError(
          'invalid_configuration',
          `Configuration not found: ${this.paths.configFile}`,
        );
      }
      await this.write(DEFAULT_CONFIG, false);
      return structuredClone(DEFAULT_CONFIG);
    }
    const text = await readFile(this.paths.configFile, 'utf8');
    const doc = parseDocument(text, { prettyErrors: true, keepSourceTokens: true });
    if (doc.errors.length) {
      throw new UsageError('invalid_configuration', doc.errors[0]?.message ?? 'Invalid YAML');
    }
    return validateConfig(doc.toJS());
  }

  async write(config: UsageConfig, backup = true): Promise<void> {
    validateConfig(config);
    await ensurePrivateDir(this.paths.configDir);
    if (backup && (await this.exists())) {
      const tempBackup = `${this.paths.backupFile}.${randomUUID()}.tmp`;
      await copyFile(this.paths.configFile, tempBackup);
      await chmod(tempBackup, 0o600);
      await rename(tempBackup, this.paths.backupFile);
    }
    let doc: Document.Parsed;
    if (await this.exists()) {
      doc = parseDocument(await readFile(this.paths.configFile, 'utf8'), {
        keepSourceTokens: true,
      });
      if (!isMap(doc.contents)) doc = new Document(config) as Document.Parsed;
      else {
        doc.set('schemaVersion', config.schemaVersion);
        doc.set('defaults', config.defaults);
        doc.set('accounts', config.accounts);
      }
    } else {
      doc = new Document(config) as Document.Parsed;
      doc.commentBefore = 'quota-usage configuration; unknown fields are rejected';
    }
    await atomicText(this.paths.configFile, doc.toString({ lineWidth: 0 }));
  }

  async permissions(): Promise<{ path: string; mode: number; expected: number }[]> {
    const checks: { path: string; mode: number; expected: number }[] = [];
    for (const [path, expected] of [
      [this.paths.configDir, 0o700],
      [this.paths.configFile, 0o600],
      [this.paths.backupFile, 0o600],
      [this.paths.dataDir, 0o700],
      [this.paths.managedRoot, 0o700],
      [this.paths.binDir, 0o700],
      [this.paths.cacheDir, 0o700],
    ] as const) {
      const info = await stat(path).catch(() => undefined);
      if (info) checks.push({ path, mode: info.mode & 0o777, expected });
    }
    return checks;
  }
}

export function findAccount(config: UsageConfig, provider: Provider, label: string): AccountConfig {
  const account = config.accounts.find(
    (item) => item.provider === provider && item.label === label,
  );
  if (!account) {
    throw new UsageError('invalid_configuration', `Unknown account: ${provider}:${label}`);
  }
  return account;
}
