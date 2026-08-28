import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { UsageError } from '../errors.js';
import { parseVersion, compareVersions, vendorEnvironment } from '../executable.js';
import { childOwned, ProcessTracker, runProcess } from '../processes.js';
import type {
  AccountConfig,
  AccountResult,
  CollectionOptions,
  Credits,
  ProviderAdapter,
  QuotaWindow,
} from '../types.js';

const MIN_CODEX_VERSION = '0.150.1';

interface RpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
}

interface AccountIdentity {
  email?: string;
  plan?: string;
  type?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().normalize('NFKC');
}

export function identityHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = normalizeEmail(email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('parse_failure', 'Codex returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeReset(value: unknown): {
  original?: number | string | null;
  iso?: string | null;
} {
  if (value === null) return { original: null, iso: null };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { original: value, iso: new Date(value * 1_000).toISOString() };
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return {
      original: value,
      iso: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    };
  }
  return {};
}

function normalizeWindow(
  limitId: string,
  limitName: string | undefined,
  slot: string,
  raw: unknown,
  reachedType: unknown,
): QuotaWindow | undefined {
  if (raw === null || raw === undefined) return undefined;
  const item = record(raw);
  const used = number(item.usedPercent);
  if (used === undefined)
    throw new UsageError('parse_failure', 'Codex quota window omitted usedPercent');
  const durationMins = number(item.windowDurationMins);
  const reset = normalizeReset(item.resetsAt);
  return {
    id: `${limitId}:${slot}`,
    ...(limitName === undefined ? {} : { label: limitName }),
    usedPercent: used,
    remainingPercent: Math.min(100, Math.max(0, 100 - used)),
    ...(reset.original === undefined ? {} : { resetOriginal: reset.original }),
    ...(reset.iso === undefined ? {} : { resetAt: reset.iso }),
    ...(durationMins === undefined ? {} : { durationSeconds: durationMins * 60 }),
    reached: reachedType !== null && reachedType !== undefined ? true : used >= 100,
  };
}

export function normalizeCodexRateLimits(
  raw: unknown,
  account: Pick<AccountConfig, 'label'>,
  collectedAt = new Date(),
  plan?: string,
): AccountResult {
  const result = record(raw);
  const bucketsRaw = result.rateLimitsByLimitId;
  let bucketEntries: Array<[string, unknown]> = [];
  if (bucketsRaw && typeof bucketsRaw === 'object' && !Array.isArray(bucketsRaw)) {
    bucketEntries = Object.entries(bucketsRaw as Record<string, unknown>);
  } else if (result.rateLimits !== undefined && result.rateLimits !== null) {
    const legacy = record(result.rateLimits);
    bucketEntries = [[typeof legacy.limitId === 'string' ? legacy.limitId : 'codex', legacy]];
  }
  if (!bucketEntries.length)
    throw new UsageError('parse_failure', 'Codex returned no quota buckets');
  const windows: QuotaWindow[] = [];
  let reportedPlan = plan;
  let credits: Credits | undefined;
  for (const [key, value] of bucketEntries) {
    const bucket = record(value);
    const limitId = typeof bucket.limitId === 'string' ? bucket.limitId : key;
    const limitName = typeof bucket.limitName === 'string' ? bucket.limitName : undefined;
    if (typeof bucket.planType === 'string') reportedPlan ??= bucket.planType;
    for (const slot of ['primary', 'secondary']) {
      const window = normalizeWindow(
        limitId,
        limitName,
        slot,
        bucket[slot],
        bucket.rateLimitReachedType,
      );
      if (window) windows.push(window);
    }
    if (bucket.credits && typeof bucket.credits === 'object') {
      credits = { details: [bucket.credits as Record<string, boolean | number | string | null>] };
    }
  }
  const resetCredits = result.rateLimitResetCredits;
  if (resetCredits && typeof resetCredits === 'object' && !Array.isArray(resetCredits)) {
    const value = resetCredits as Record<string, unknown>;
    credits = {
      ...(credits ?? {}),
      ...(typeof value.availableCount === 'number' ? { available: value.availableCount } : {}),
      ...(Array.isArray(value.credits)
        ? {
            details: value.credits.filter(
              (item): item is Record<string, boolean | number | string | null> =>
                !!item && typeof item === 'object' && !Array.isArray(item),
            ),
          }
        : {}),
    };
  }
  return {
    provider: 'codex',
    label: account.label,
    ...(reportedPlan === undefined ? {} : { plan: reportedPlan }),
    source: 'codex-app-server',
    status: 'live',
    collectedAt: collectedAt.toISOString(),
    windows,
    ...(credits === undefined ? {} : { credits }),
  };
}

class JsonRpcSession {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private malformed: UsageError | undefined;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<unknown>;

  constructor(
    executable: string,
    stateDir: string,
    private readonly tracker: ProcessTracker,
  ) {
    this.child = spawn(executable, ['app-server', '--stdio'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: vendorEnvironment('codex', stateDir),
    });
    this.exited = once(this.child, 'exit');
    this.tracker.track(childOwned(this.child));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch (error) {
        this.malformed = new UsageError(
          'parse_failure',
          'Codex app-server emitted malformed JSON',
          {
            cause: error,
          },
        );
        for (const pending of this.pending.values()) pending.reject(this.malformed);
        this.pending.clear();
        return;
      }
      if (typeof message.id !== 'number') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(
          new UsageError('provider_failure', message.error.message ?? 'Codex request failed', {
            retryable: false,
          }),
        );
      } else request.resolve(message.result);
    });
    this.child.on('error', (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(
          new UsageError('provider_failure', `Could not start Codex app-server: ${error.message}`, {
            retryable: true,
            details: { phase: 'startup' },
          }),
        );
      }
      this.pending.clear();
    });
    void this.exited.then(() => {
      for (const pending of this.pending.values()) {
        pending.reject(
          new UsageError('provider_failure', 'Codex app-server exited unexpectedly', {
            retryable: true,
            details: { phase: 'transport' },
          }),
        );
      }
      this.pending.clear();
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.malformed) return Promise.reject(this.malformed);
    const id = this.nextId++;
    const payload = { method, id, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(
            new UsageError('provider_failure', 'Codex app-server transport failed', {
              retryable: true,
              details: { phase: 'transport' },
              cause: error,
            }),
          );
        }
      });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await Promise.race([
      this.exited.catch(() => undefined),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
    await Promise.race([
      this.exited.catch(() => undefined),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    await this.exited.catch(() => undefined);
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const;

  constructor(
    private readonly executable: string,
    private readonly tracker: ProcessTracker,
  ) {}

  async version(timeoutMs = 2_000): Promise<string> {
    const result = await runProcess(this.executable, ['--version'], {
      timeoutMs,
      tracker: this.tracker,
    });
    const version = parseVersion(result.stdout);
    if (!version || compareVersions(version, MIN_CODEX_VERSION) < 0) {
      throw new UsageError(
        'unsupported_vendor_version',
        `Codex ${version ?? 'unknown'} is unsupported; ${MIN_CODEX_VERSION} or newer is required`,
        { provider: 'codex' },
      );
    }
    return version;
  }

  private async sessionData(
    account: AccountConfig,
    timeoutMs: number,
    includeLimits: boolean,
  ): Promise<{ identity: AccountIdentity; limits?: unknown }> {
    const session = new JsonRpcSession(this.executable, account.stateDir, this.tracker);
    let timer: NodeJS.Timeout | undefined;
    try {
      const operation = async (): Promise<{ identity: AccountIdentity; limits?: unknown }> => {
        await session.request('initialize', {
          clientInfo: { name: 'quota_usage', title: 'quota-usage', version: '0.1.0' },
        });
        session.notify('initialized');
        const accountResult = record(
          await session.request('account/read', { refreshToken: false }),
        );
        if (accountResult.account === null || accountResult.account === undefined) {
          throw new UsageError(
            'logged_out_account',
            `Codex account ${account.label} is logged out`,
            {
              provider: 'codex',
              accountLabel: account.label,
            },
          );
        }
        const identityRaw = record(accountResult.account);
        const identity: AccountIdentity = {
          ...(typeof identityRaw.email === 'string' ? { email: identityRaw.email } : {}),
          ...(typeof identityRaw.planType === 'string' ? { plan: identityRaw.planType } : {}),
          ...(typeof identityRaw.type === 'string' ? { type: identityRaw.type } : {}),
        };
        if (account.identityHash) {
          if (!identity.email || identityHash(identity.email) !== account.identityHash) {
            throw new UsageError(
              'identity_mismatch',
              `Codex identity changed for ${account.label}`,
              {
                provider: 'codex',
                accountLabel: account.label,
              },
            );
          }
        }
        if (!includeLimits) return { identity };
        return { identity, limits: await session.request('account/rateLimits/read') };
      };
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            session.child.kill('SIGTERM');
            reject(
              new UsageError('timeout', `Codex check timed out for ${account.label}`, {
                provider: 'codex',
                accountLabel: account.label,
              }),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await session.close();
    }
  }

  async readIdentity(account: AccountConfig, timeoutMs: number): Promise<AccountIdentity> {
    return (await this.sessionData(account, timeoutMs, false)).identity;
  }

  async collect(account: AccountConfig, options: CollectionOptions): Promise<AccountResult> {
    await this.version();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { identity, limits } = await this.sessionData(account, options.timeoutMs, true);
        if (limits === undefined)
          throw new UsageError('parse_failure', 'Codex returned no rate limits');
        return normalizeCodexRateLimits(limits, account, options.now ?? new Date(), identity.plan);
      } catch (error) {
        const retryable = error instanceof UsageError && error.data.retryable;
        if (!retryable || attempt >= 1) throw error;
        options.verbose?.(`Retrying codex:${account.label} after transport failure`);
      }
    }
    throw new UsageError('provider_failure', 'Codex collection failed');
  }
}
