import { UsageError } from '../errors.js';
import type { AccountConfig, AccountResult, QuotaWindow } from '../types.js';

const KNOWN_DURATIONS: Record<string, number> = {
  five_hour: 5 * 3_600,
  seven_day: 7 * 86_400,
};

function displayLabel(id: string): string {
  return id
    .replace(/^five_hour$/, '5h')
    .replace(/^seven_day$/, '7d')
    .replaceAll('_', ' ');
}

export function extractClaudeStatusLine(
  input: unknown,
  account: Pick<AccountConfig, 'label'>,
  collectedAt = new Date(),
): AccountResult | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const root = input as Record<string, unknown>;
  if (
    !root.rate_limits ||
    typeof root.rate_limits !== 'object' ||
    Array.isArray(root.rate_limits)
  ) {
    return undefined;
  }
  const windows: QuotaWindow[] = [];
  for (const [id, raw] of Object.entries(root.rate_limits as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    if (typeof value.used_percentage !== 'number' || !Number.isFinite(value.used_percentage))
      continue;
    const used = value.used_percentage;
    let resetAt: string | null | undefined;
    let resetOriginal: number | string | null | undefined;
    if (typeof value.resets_at === 'number' && Number.isFinite(value.resets_at)) {
      resetOriginal = value.resets_at;
      resetAt = new Date(value.resets_at * 1_000).toISOString();
    } else if (typeof value.resets_at === 'string') {
      resetOriginal = value.resets_at;
      const parsed = Date.parse(value.resets_at);
      resetAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    } else if (value.resets_at === null) {
      resetOriginal = null;
      resetAt = null;
    }
    windows.push({
      id,
      label: displayLabel(id),
      usedPercent: used,
      remainingPercent: Math.min(100, Math.max(0, 100 - used)),
      ...(resetOriginal === undefined ? {} : { resetOriginal }),
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(KNOWN_DURATIONS[id] === undefined ? {} : { durationSeconds: KNOWN_DURATIONS[id] }),
      reached: used >= 100,
    });
  }
  if (!windows.length) return undefined;
  return {
    provider: 'claude',
    label: account.label,
    source: 'claude-statusline',
    status: 'cached',
    collectedAt: collectedAt.toISOString(),
    windows,
  };
}

export function parseClaudeStatusLine(
  text: string,
  account: Pick<AccountConfig, 'label'>,
  collectedAt?: Date,
): AccountResult | undefined {
  try {
    return extractClaudeStatusLine(JSON.parse(text), account, collectedAt);
  } catch (error) {
    throw new UsageError('parse_failure', 'Claude status-line input was invalid JSON', {
      provider: 'claude',
      accountLabel: account.label,
      cause: error,
    });
  }
}
