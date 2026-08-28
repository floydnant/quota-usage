import { formatDuration } from './duration.js';
import type { AccountResult, QuotaWindow, UsageErrorData } from './types.js';

export type ColorMode = 'always' | 'auto' | 'never';

const ANSI = { red: '\u001b[31m', yellow: '\u001b[33m', green: '\u001b[32m', reset: '\u001b[0m' };

function shouldColor(mode: ColorMode, tty: boolean, env: NodeJS.ProcessEnv): boolean {
  if (mode === 'never' || env.NO_COLOR !== undefined) return false;
  return mode === 'always' || tty;
}

function tint(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

export function quotaBar(usedPercent: number): string {
  const used = Math.min(20, Math.max(0, Math.round(usedPercent / 5)));
  return `[${'#'.repeat(used)}${'-'.repeat(20 - used)}]`;
}

function windowLabel(window: QuotaWindow): string {
  if (window.label) return window.label;
  if (window.durationSeconds) {
    if (window.durationSeconds % 86_400 === 0) return `${window.durationSeconds / 86_400}d`;
    if (window.durationSeconds % 3_600 === 0) return `${window.durationSeconds / 3_600}h`;
  }
  return window.id;
}

function windowOrder(a: QuotaWindow, b: QuotaWindow): number {
  if (a.durationSeconds !== undefined && b.durationSeconds !== undefined)
    return a.durationSeconds - b.durationSeconds;
  if (a.durationSeconds !== undefined) return -1;
  if (b.durationSeconds !== undefined) return 1;
  return a.id.localeCompare(b.id);
}

function sourceLabel(result: AccountResult): string {
  if (result.status === 'live') return 'live';
  if (result.status === 'unavailable') return 'unavailable';
  if (result.status === 'expired') return 'expired';
  const age = formatDuration(result.cacheAgeSeconds ?? 0);
  return `${result.status} ${age} ago`;
}

function resetLabel(window: QuotaWindow, now: Date): string {
  if (!window.resetAt) return 'reset unknown';
  const reset = Date.parse(window.resetAt);
  if (!Number.isFinite(reset)) return 'reset unknown';
  const relative = formatDuration((reset - now.getTime()) / 1_000);
  const local = new Intl.DateTimeFormat(undefined, {
    weekday: reset - now.getTime() > 86_400_000 ? 'short' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(reset));
  return `resets in ${relative}, ${local}`;
}

export function renderHuman(
  results: AccountResult[],
  errors: UsageErrorData[],
  options: { color: ColorMode; tty?: boolean; env?: NodeJS.ProcessEnv; now?: Date },
): string {
  const color = shouldColor(options.color, options.tty ?? false, options.env ?? process.env);
  const now = options.now ?? new Date();
  const sorted = [...results].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
  );
  const lines: string[] = [];
  for (const result of sorted) {
    const provider = result.provider === 'codex' ? 'Codex' : 'Claude';
    const metadata = [provider, result.label, result.plan, sourceLabel(result)]
      .filter(Boolean)
      .join('  ');
    const headingColor =
      result.status === 'expired' || result.status === 'unavailable'
        ? 'red'
        : result.status === 'stale'
          ? 'yellow'
          : 'green';
    lines.push(tint(metadata, headingColor, color));
    if (result.status === 'unavailable' || !result.windows.length) {
      lines.push(`  ${tint(result.error?.message ?? 'Unavailable', 'red', color)}`);
    } else {
      for (const window of [...result.windows].sort(windowOrder)) {
        const percent = Math.round(window.usedPercent);
        const reached = window.reached || window.usedPercent >= 100;
        const barColor =
          reached || window.usedPercent >= 80
            ? 'red'
            : window.usedPercent >= 60
              ? 'yellow'
              : 'green';
        const suffix = reached ? '  LIMIT REACHED' : '';
        lines.push(
          `  ${windowLabel(window).padEnd(5)} ${tint(quotaBar(window.usedPercent), barColor, color)}  ${percent}% used  ${resetLabel(window, now)}${tint(suffix, 'red', color)}`,
        );
      }
      if (result.credits) {
        const details = [
          result.credits.available === undefined
            ? undefined
            : `${result.credits.available} reset credits`,
          result.credits.balance === undefined
            ? undefined
            : `${result.credits.balance}${result.credits.unit ? ` ${result.credits.unit}` : ''}`,
        ].filter(Boolean);
        if (details.length) lines.push(`  Credits: ${details.join(', ')}`);
      }
    }
    lines.push('');
  }
  if (!sorted.length && errors.length) {
    for (const error of errors) lines.push(tint(error.message, 'red', color));
  }
  return lines.join('\n').trimEnd();
}
