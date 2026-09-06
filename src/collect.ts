import { readCache, writeCache } from './cache.js';
import { discoverAccounts } from './discovery.js';
import { parseDuration } from './duration.js';
import { asUsageError, UsageError } from './errors.js';
import { resolveExecutable } from './executable.js';
import { appPaths, type AppPaths } from './paths.js';
import { ProcessTracker } from './processes.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeLiveAdapter } from './providers/claude-live.js';
import { accountDirectoryName, selectAccounts } from './selectors.js';
import type {
  AccountConfig,
  AccountResult,
  CollectionMode,
  ErrorCode,
  UsageConfig,
  UsageErrorData,
} from './types.js';

export interface CollectRequest {
  config: UsageConfig;
  discover?: boolean;
  selectors: string[];
  mode: CollectionMode;
  paths?: AppPaths;
  tracker?: ProcessTracker;
  now?: Date;
  codexTimeout?: string;
  claudeTimeout?: string;
  verbose?: (message: string) => void;
}

export interface CollectionSummary {
  results: AccountResult[];
  errors: UsageErrorData[];
  exitCode: 0 | 1 | 2;
}

function errorResult(account: AccountConfig, error: UsageErrorData, now: Date): AccountResult {
  return {
    provider: account.provider,
    label: account.label,
    source: 'unavailable',
    status: 'unavailable',
    collectedAt: now.toISOString(),
    windows: [],
    error,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      result[index] = await task(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

export async function collectUsage(request: CollectRequest): Promise<CollectionSummary> {
  const paths = request.paths ?? appPaths();
  const tracker = request.tracker ?? new ProcessTracker();
  const now = request.now ?? new Date();
  const staleMs = parseDuration(request.config.defaults.staleAfter);
  const inventory =
    request.discover === false
      ? { accounts: request.config.accounts, errors: [] }
      : await discoverAccounts(request.config.accounts, paths.homeDir);
  const accounts = selectAccounts(inventory.accounts, request.selectors);
  const errors: UsageErrorData[] = [...inventory.errors];
  const finish = (results: AccountResult[]): CollectionSummary =>
    summarize(
      results.map((result) => {
        const account = accounts.find(
          (item) => item.provider === result.provider && item.label === result.label,
        );
        return account ? { ...result, directoryName: accountDirectoryName(account) } : result;
      }),
      errors,
    );

  const collectCached = async (account: AccountConfig): Promise<AccountResult> => {
    try {
      const cached = await readCache(
        paths,
        account.provider,
        account.label,
        now,
        staleMs,
        account.discoveryKey,
      );
      if (cached.status === 'expired') {
        const error = new UsageError(
          'expired_cache',
          `Cached reading expired for ${account.provider}:${account.label}`,
          {
            provider: account.provider,
            accountLabel: account.label,
          },
        ).data;
        errors.push(error);
        return { ...cached, error };
      }
      return cached;
    } catch (error) {
      const data = asUsageError(error, {
        code: 'missing_cache',
        provider: account.provider,
        accountLabel: account.label,
        retryable: false,
      });
      errors.push(data);
      return errorResult(account, data, now);
    }
  };

  if (request.mode === 'cached') {
    const results = await Promise.all(accounts.map(collectCached));
    return finish(results);
  }

  const codexAccounts = accounts.filter((account) => account.provider === 'codex');
  const claudeAccounts = accounts.filter((account) => account.provider === 'claude');
  let codex: CodexAdapter | undefined;
  let claude: ClaudeLiveAdapter | undefined;
  let codexSetupError: UsageErrorData | undefined;
  let claudeSetupError: UsageErrorData | undefined;
  if (codexAccounts.length) {
    try {
      const executable = await resolveExecutable(
        'codex',
        request.config.defaults.codexExecutable,
        'codex',
      );
      codex = new CodexAdapter(executable, tracker);
    } catch (error) {
      codexSetupError = asUsageError(error, {
        code: 'missing_vendor_executable',
        provider: 'codex',
        retryable: false,
      });
    }
  }
  if (claudeAccounts.length) {
    try {
      const executable = await resolveExecutable(
        'claude',
        request.config.defaults.claudeExecutable,
        'claude',
      );
      claude = new ClaudeLiveAdapter(executable, tracker);
    } catch (error) {
      claudeSetupError = asUsageError(error, {
        code: 'missing_vendor_executable',
        provider: 'claude',
        retryable: false,
      });
    }
  }

  async function liveWithFallback(
    account: AccountConfig,
    task: () => Promise<AccountResult>,
  ): Promise<AccountResult> {
    try {
      const result = await task();
      await writeCache(paths, result, account.discoveryKey);
      return result;
    } catch (error) {
      const code: ErrorCode = error instanceof UsageError ? error.data.code : 'provider_failure';
      const liveError = asUsageError(error, {
        code,
        provider: account.provider,
        accountLabel: account.label,
        retryable: false,
      });
      liveError.provider = account.provider;
      liveError.accountLabel = account.label;
      errors.push(liveError);
      try {
        const cached = await readCache(
          paths,
          account.provider,
          account.label,
          now,
          staleMs,
          account.discoveryKey,
        );
        if (cached.status !== 'expired') {
          return {
            ...cached,
            warnings: [...(cached.warnings ?? []), `live refresh failed: ${liveError.message}`],
            error: liveError,
          };
        }
      } catch {
        // The live error is the useful primary failure.
      }
      return errorResult(account, liveError, now);
    }
  }

  const codexResults = await mapLimit(codexAccounts, 4, async (account) => {
    if (!codex) {
      const error = codexSetupError ?? {
        code: 'missing_vendor_executable' as const,
        message: 'Codex executable was not found',
        provider: 'codex' as const,
        accountLabel: account.label,
        retryable: false,
      };
      const accountError = { ...error, accountLabel: account.label };
      errors.push(accountError);
      return errorResult(account, accountError, now);
    }
    return liveWithFallback(account, () =>
      codex.collect(account, {
        timeoutMs: parseDuration(request.codexTimeout ?? request.config.defaults.codexTimeout),
        now,
        ...(request.verbose === undefined ? {} : { verbose: request.verbose }),
      }),
    );
  });

  const claudeResults: AccountResult[] = [];
  for (const account of claudeAccounts) {
    if (!claude) {
      const error = claudeSetupError ?? {
        code: 'missing_vendor_executable' as const,
        message: 'Claude executable was not found',
        provider: 'claude' as const,
        accountLabel: account.label,
        retryable: false,
      };
      const accountError = { ...error, accountLabel: account.label };
      errors.push(accountError);
      claudeResults.push(errorResult(account, accountError, now));
    } else {
      claudeResults.push(
        await liveWithFallback(account, () =>
          claude.collect(account, {
            timeoutMs: parseDuration(
              request.claudeTimeout ?? request.config.defaults.claudeTimeout,
            ),
            now,
            ...(request.verbose === undefined ? {} : { verbose: request.verbose }),
          }),
        ),
      );
    }
  }
  return finish([...codexResults, ...claudeResults]);
}

export function summarize(results: AccountResult[], errors: UsageErrorData[]): CollectionSummary {
  const sorted = [...results].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
  );
  const usable = sorted.filter((result) =>
    ['live', 'cached', 'stale'].includes(result.status),
  ).length;
  return { results: sorted, errors, exitCode: errors.length ? (usable ? 1 : 2) : 0 };
}
