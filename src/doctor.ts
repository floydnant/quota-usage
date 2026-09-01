import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { cachePath, readCache } from './cache.js';
import { ConfigStore } from './config.js';
import { parseDuration } from './duration.js';
import {
  compareVersions,
  resolveExecutable,
  parseVersion,
  vendorEnvironment,
} from './executable.js';
import { canonicalStateStillMatches, collectorPaths } from './accounts.js';
import { ProcessTracker, runProcess } from './processes.js';
import { appPaths } from './paths.js';
import { MIN_CLAUDE_MULTI_ACCOUNT_VERSION } from './providers/claude-live.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(store = new ConfigStore(appPaths())): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let config;
  try {
    config = await store.load();
    checks.push({ name: 'configuration', ok: true, detail: 'valid schema version 1' });
  } catch (error) {
    checks.push({
      name: 'configuration',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return checks;
  }
  for (const permission of await store.permissions()) {
    checks.push({
      name: `permissions ${permission.path}`,
      ok: permission.mode === permission.expected,
      detail: `${permission.mode.toString(8).padStart(4, '0')} (expected ${permission.expected.toString(8).padStart(4, '0')})`,
    });
  }
  const tracker = new ProcessTracker();
  const executables = new Map<string, string>();
  for (const provider of ['codex', 'claude'] as const) {
    try {
      const executable = await resolveExecutable(
        provider,
        provider === 'codex' ? config.defaults.codexExecutable : config.defaults.claudeExecutable,
        provider,
      );
      executables.set(provider, executable);
      const version = await runProcess(executable, ['--version'], { timeoutMs: 2_000, tracker });
      const parsedVersion = parseVersion(version.stdout);
      checks.push({
        name: `${provider} executable`,
        ok: version.code === 0,
        detail: `${executable} (${parsedVersion ?? 'unknown'})`,
      });
      if (provider === 'claude') {
        const supported =
          parsedVersion !== undefined &&
          compareVersions(parsedVersion, MIN_CLAUDE_MULTI_ACCOUNT_VERSION) >= 0;
        checks.push({
          name: 'Claude multi-account version',
          ok: supported,
          detail: supported
            ? `${parsedVersion} is supported`
            : `${parsedVersion ?? 'unknown'} is below required ${MIN_CLAUDE_MULTI_ACCOUNT_VERSION}`,
        });
      }
      if (provider === 'codex') {
        const capability = await runProcess(executable, ['app-server', '--help'], {
          timeoutMs: 2_000,
          tracker,
        });
        checks.push({
          name: 'Codex app-server capability',
          ok: capability.code === 0 && capability.stdout.includes('--stdio'),
          detail: capability.code === 0 ? 'stdio supported' : 'unavailable',
        });
      }
    } catch (error) {
      checks.push({
        name: `${provider} executable`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const now = new Date();
  for (const account of config.accounts) {
    checks.push({
      name: `${account.provider}:${account.label} canonical path`,
      ok: await canonicalStateStillMatches(account),
      detail: account.stateDir,
    });
    const executable = executables.get(account.provider);
    if (executable) {
      const status = await runProcess(
        executable,
        account.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'],
        {
          env: vendorEnvironment(account.provider, account.stateDir, process.env, {
            claudeDefault: account.claudeDefault,
          }),
          timeoutMs: 5_000,
          tracker,
        },
      );
      checks.push({
        name: `${account.provider}:${account.label} login`,
        ok: status.code === 0,
        detail: status.code === 0 ? 'vendor reports logged in' : 'vendor reports logged out',
      });
    }
    if (account.ownership === 'managed') {
      const marker = await readFile(join(account.stateDir, '.usage-owner'), 'utf8')
        .then((text) => JSON.parse(text) as { id?: string })
        .catch(() => undefined);
      checks.push({
        name: `${account.provider}:${account.label} ownership`,
        ok: marker?.id === account.ownershipMarker,
        detail:
          marker?.id === account.ownershipMarker ? 'marker valid' : 'marker missing or mismatched',
      });
    }
    if (account.provider === 'claude' && account.claudeCollector) {
      const settings = await readFile(join(account.stateDir, 'settings.json'), 'utf8')
        .then((text) => JSON.parse(text) as { statusLine?: { command?: string } })
        .catch(() => undefined);
      const helper = collectorPaths(store, account.label).helper;
      const installed = await access(helper, constants.X_OK).then(
        () => true,
        () => false,
      );
      const matches = settings?.statusLine?.command === account.claudeCollector.wrapperCommand;
      checks.push({
        name: `claude:${account.label} collector`,
        ok: installed && matches,
        detail: !installed
          ? 'helper missing'
          : matches
            ? 'installed and configured'
            : 'configuration drift',
      });
    }
    try {
      const cached = await readCache(
        store.paths,
        account.provider,
        account.label,
        now,
        parseDuration(config.defaults.staleAfter),
      );
      const info = await stat(cachePath(store.paths, account.provider, account.label));
      const mode = info.mode & 0o777;
      checks.push({
        name: `${account.provider}:${account.label} cache`,
        ok: cached.status !== 'expired' && mode === 0o600,
        detail: `${cached.status}, mode ${mode.toString(8).padStart(4, '0')}`,
      });
    } catch (error) {
      checks.push({
        name: `${account.provider}:${account.label} cache`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await tracker.cleanup();
  return checks;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? 'OK' : 'FAIL'}  ${check.name}: ${check.detail}`)
    .join('\n');
}
