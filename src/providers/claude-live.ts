import { homedir } from 'node:os';
import { UsageError } from '../errors.js';
import { compareVersions, parseVersion, vendorEnvironment } from '../executable.js';
import { ProcessTracker, runProcess, type RunResult } from '../processes.js';
import type {
  AccountConfig,
  AccountResult,
  CollectionOptions,
  ProviderAdapter,
  QuotaWindow,
} from '../types.js';

export const MIN_CLAUDE_MULTI_ACCOUNT_VERSION = '2.1.238';

interface ClaudePrintEnvelope {
  result?: unknown;
  is_error?: unknown;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function datePartsInZone(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
  };
}

function dateInZone(parts: LocalDateParts, timeZone: string): Date {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let timestamp = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = datePartsInZone(new Date(timestamp), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    timestamp += desired - represented;
  }
  return new Date(timestamp);
}

function parseClaudeLocalReset(text: string, now: Date): Date | undefined {
  const match =
    /reset(?:s|ting)?\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^)]+)\))?/i.exec(
      text,
    );
  if (!match) return undefined;
  const timeZone = match[7] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const current = datePartsInZone(now, timeZone);
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    let hour = Number(match[4]);
    if (match[6]?.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (match[6]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    const month = match[1] ? months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1 : current.month;
    const day = match[2] ? Number(match[2]) : current.day;
    let year = match[3] ? Number(match[3]) : current.year;
    let result = dateInZone({ year, month, day, hour, minute: Number(match[5] ?? 0) }, timeZone);
    if (result.getTime() <= now.getTime() && !match[3]) {
      if (match[1]) year += 1;
      else {
        const next = new Date(Date.UTC(year, month - 1, day + 1));
        return dateInZone(
          {
            year: next.getUTCFullYear(),
            month: next.getUTCMonth() + 1,
            day: next.getUTCDate(),
            hour,
            minute: Number(match[5] ?? 0),
          },
          timeZone,
        );
      }
      result = dateInZone({ year, month, day, hour, minute: Number(match[5] ?? 0) }, timeZone);
    }
    return result;
  } catch {
    return undefined;
  }
}

function parseReset(text: string, now: Date): string | null {
  const unix = /\b(1\d{9})\b/.exec(text)?.[1];
  if (unix) return new Date(Number(unix) * 1_000).toISOString();
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/.exec(
    text,
  )?.[0];
  if (iso) return new Date(iso).toISOString();
  const local = parseClaudeLocalReset(text, now);
  if (local) return local.toISOString();
  const relative = /reset(?:s|ting)? in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/i.exec(text);
  if (relative) {
    const seconds =
      Number(relative[1] ?? 0) * 86_400 +
      Number(relative[2] ?? 0) * 3_600 +
      Number(relative[3] ?? 0) * 60;
    return new Date(now.getTime() + seconds * 1_000).toISOString();
  }
  return null;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function quotaIdentity(label: string): {
  id: string;
  display: string;
  durationSeconds: number;
} | null {
  if (/^current session(?:\s*\(\s*5\s*(?:h|hour)[^)]*\))?$/i.test(label)) {
    return { id: 'five_hour', display: '5h', durationSeconds: 5 * 3_600 };
  }
  const weekly = /^current week(?:\s*\(([^)]+)\))?$/i.exec(label);
  if (!weekly) return null;
  const scope = weekly[1]?.trim();
  if (!scope || /^all models$/i.test(scope)) {
    return { id: 'seven_day', display: '7d', durationSeconds: 7 * 86_400 };
  }
  return {
    id: `seven_day_${slug(scope)}`,
    display: `${scope} 7d`,
    durationSeconds: 7 * 86_400,
  };
}

function providerScreenError(
  text: string,
  account: Pick<AccountConfig, 'label'>,
): UsageError | null {
  if (
    /log in|sign in|not logged in|\/login|auth(?:entication)? (?:required|failed)|not authenticated|unauthorized/i.test(
      text,
    )
  ) {
    return new UsageError('logged_out_account', `Claude account ${account.label} is logged out`, {
      provider: 'claude',
      accountLabel: account.label,
    });
  }
  if (/network error|connection (?:failed|error)|unable to connect/i.test(text)) {
    return new UsageError('provider_failure', 'Claude reported a network error', {
      provider: 'claude',
      accountLabel: account.label,
      retryable: true,
    });
  }
  if (/failed to load usage data|usage endpoint is rate limited/i.test(text)) {
    return new UsageError('provider_failure', 'Claude could not load usage data', {
      provider: 'claude',
      accountLabel: account.label,
      retryable: true,
    });
  }
  if (/upgrade required|update available|new version (?:is )?available/i.test(text)) {
    return new UsageError('provider_failure', 'Claude displayed an upgrade notice', {
      provider: 'claude',
      accountLabel: account.label,
    });
  }
  return null;
}

export function parseClaudeUsageText(
  text: string,
  account: Pick<AccountConfig, 'label'>,
  now = new Date(),
): AccountResult {
  const screenError = providerScreenError(text, account);
  if (screenError) throw screenError;
  const windows: QuotaWindow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match =
      /^(Current session(?:\s*\(\s*5\s*(?:h|hour)[^)]*\))?|Current week(?:\s*\([^)]+\))?)\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used\s*(?:[·|-]\s*)?(.*)$/i.exec(
        line,
      );
    if (!match) continue;
    const quotaLabel = match[1];
    if (!quotaLabel) continue;
    const identity = quotaIdentity(quotaLabel);
    if (!identity || windows.some((window) => window.id === identity.id)) continue;
    const usedPercent = Number(match[2]);
    if (!Number.isFinite(usedPercent)) continue;
    const resetText = match[3] ?? '';
    windows.push({
      id: identity.id,
      label: identity.display,
      usedPercent,
      remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
      resetOriginal: /reset/i.test(resetText) ? resetText.slice(0, 300) : null,
      resetAt: parseReset(resetText, now),
      durationSeconds: identity.durationSeconds,
      reached: usedPercent >= 100 || /limit reached|blocked/i.test(resetText),
    });
  }
  if (!windows.length) {
    throw new UsageError(
      'parse_failure',
      'Claude /usage output did not contain recognizable quota windows',
      {
        provider: 'claude',
        accountLabel: account.label,
        retryable: true,
      },
    );
  }
  const extraUsage =
    /(?:paid )?extra usage[^\n]*(?:balance|remaining)[^\d$€£]*([$€£]?\s*\d+(?:\.\d+)?)/i.exec(
      text,
    )?.[1];
  return {
    provider: 'claude',
    label: account.label,
    source: 'claude-cli',
    status: 'live',
    collectedAt: now.toISOString(),
    windows,
    ...(extraUsage ? { credits: { balance: extraUsage.replaceAll(' ', '') } } : {}),
  };
}

export function parseClaudePrintResult(
  processResult: RunResult,
  account: Pick<AccountConfig, 'label'>,
  now = new Date(),
): AccountResult {
  if (processResult.code !== 0) {
    const combined = `${processResult.stdout}\n${processResult.stderr}`;
    const screenError = providerScreenError(combined, account);
    if (screenError) throw screenError;
    throw new UsageError('provider_failure', 'Claude noninteractive usage check failed', {
      provider: 'claude',
      accountLabel: account.label,
      retryable: true,
      details: { exitCode: processResult.code },
    });
  }
  let envelope: ClaudePrintEnvelope;
  try {
    envelope = JSON.parse(processResult.stdout) as ClaudePrintEnvelope;
  } catch (error) {
    throw new UsageError('parse_failure', 'Claude returned invalid noninteractive JSON', {
      provider: 'claude',
      accountLabel: account.label,
      retryable: true,
      cause: error,
    });
  }
  if (envelope.is_error === true && typeof envelope.result === 'string') {
    const screenError = providerScreenError(envelope.result, account);
    if (screenError) throw screenError;
  }
  if (envelope.is_error === true || typeof envelope.result !== 'string') {
    throw new UsageError('parse_failure', 'Claude returned an incomplete usage response', {
      provider: 'claude',
      accountLabel: account.label,
      retryable: true,
    });
  }
  return parseClaudeUsageText(envelope.result, account, now);
}

export class ClaudeLiveAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;

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
    if (!version || compareVersions(version, MIN_CLAUDE_MULTI_ACCOUNT_VERSION) < 0) {
      throw new UsageError(
        'unsupported_vendor_version',
        `Claude Code ${version ?? 'unknown'} is unsupported for managed multi-account use; ${MIN_CLAUDE_MULTI_ACCOUNT_VERSION} or newer is required`,
        { provider: 'claude' },
      );
    }
    return version;
  }

  async collect(account: AccountConfig, options: CollectionOptions): Promise<AccountResult> {
    const version = await this.version();
    options.verbose?.(`claude:${account.label}: version ${version}`);
    const env = vendorEnvironment('claude', account.stateDir, process.env, {
      claudeDefault: account.claudeDefault,
    });
    const args = [
      '-p',
      '/usage',
      '--tools',
      '',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--safe-mode',
    ];
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      options.verbose?.(`claude:${account.label}: noninteractive usage attempt ${attempt}`);
      try {
        const result = await runProcess(this.executable, args, {
          env,
          cwd: homedir(),
          timeoutMs: options.timeoutMs,
          tracker: this.tracker,
          maxOutput: 256 * 1024,
        });
        const parsed = parseClaudePrintResult(result, account, options.now ?? new Date());
        options.verbose?.(`claude:${account.label}: noninteractive usage complete`);
        return parsed;
      } catch (caught) {
        const error =
          caught instanceof UsageError && caught.data.code === 'timeout'
            ? new UsageError('timeout', `Claude live check timed out for ${account.label}`, {
                provider: 'claude',
                accountLabel: account.label,
                retryable: true,
                cause: caught,
              })
            : caught;
        lastError = error;
        const retryable = error instanceof UsageError && error.data.retryable;
        if (!retryable || attempt === 2) throw error;
        options.verbose?.(`claude:${account.label}: incomplete usage response; retrying once`);
      }
    }
    throw lastError;
  }
}
