import { formatDuration } from './duration.js';
import type { AccountResult, QuotaWindow, UsageErrorData } from './types.js';

export type ColorMode = 'always' | 'auto' | 'never';

const ANSI = {
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  bold: '\u001b[1m',
  reset: '\u001b[0m',
  dim: '\u001b[2m',
};

function shouldColor(mode: ColorMode, tty: boolean, env: NodeJS.ProcessEnv): boolean {
  if (mode === 'never' || env.NO_COLOR !== undefined) return false;
  return mode === 'always' || tty;
}

function tint(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

export function quotaBar(usedPercent: number): string {
  const width = 20;
  const partialBlocks = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const scaled = (Math.min(100, Math.max(0, usedPercent)) / 100) * width;
  let full = Math.floor(scaled);
  let partial = Math.round((scaled - full) * 8);
  if (partial === 8) {
    full += 1;
    partial = 0;
  }
  const used = `${'█'.repeat(full)}${partialBlocks[partial] ?? ''}`;
  return `[${used}${'░'.repeat(width - full - (partial > 0 ? 1 : 0))}]`;
}

function windowLabel(window: QuotaWindow): string {
  if (window.label) return window.label;
  if (window.durationSeconds) {
    if (window.durationSeconds % 86_400 === 0) return `${window.durationSeconds / 86_400}d`;
    if (window.durationSeconds % 3_600 === 0) return `${window.durationSeconds / 3_600}h`;
  }
  return window.id;
}

function visibleWindows(result: AccountResult): QuotaWindow[] {
  return result.windows.filter(
    (window) => !(result.provider === 'codex' && window.id.startsWith('codex_bengalfox:')),
  );
}

function isReached(window: QuotaWindow): boolean {
  return window.reached === true || window.usedPercent >= 100;
}

function windowOrder(a: QuotaWindow, b: QuotaWindow): number {
  return (
    (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity) || a.id.localeCompare(b.id)
  );
}

function sourceLabel(result: AccountResult): string {
  if (result.status === 'live') return '';
  if (result.status === 'unavailable')
    return result.error?.code === 'logged_out_account' ? 'auth failed' : 'unavailable';
  if (result.status === 'expired') return 'expired';
  const age = formatDuration(result.cacheAgeSeconds ?? 0);
  return `${result.status} ${age} ago${result.error?.code === 'logged_out_account' ? ' · auth failed' : ''}`;
}

function resetLabel(
  window: QuotaWindow,
  now: Date,
  color = false,
): { text: string; formatted: string } {
  const parts = (prefix: string, relative = '', suffix = '') => {
    // Reset intensity only, preserving the enclosing red reached-limit row.
    const dim = (text: string): string => (color && text ? `${ANSI.dim}${text}\u001b[22m` : text);
    return {
      text: prefix + relative + suffix,
      formatted: dim(prefix) + relative + dim(suffix),
    };
  };
  if (!window.resetAt) return parts('reset unknown');
  const reset = Date.parse(window.resetAt);
  if (!Number.isFinite(reset)) return parts('reset unknown');
  const remainingMs = reset - now.getTime();
  const relative = formatDuration(remainingMs / 1_000);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(reset));
  const weekly = window.durationSeconds === 604_800;
  if (remainingMs < 86_400_000 && !weekly) return parts('resets in ', relative, `, ${time}`);
  const dateParts = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(new Date(reset));
  const date = dateParts.map((part) => part.value).join('');
  const label = parts('resets in ', relative, `, ${date} at ${time}`);
  if (weekly && color) {
    const highlightedDate = dateParts
      .map((part) => (part.type === 'weekday' ? `\u001b[22m${part.value}${ANSI.dim}` : part.value))
      .join('');
    label.formatted = parts('resets in ', relative, `, ${highlightedDate} at ${time}`).formatted;
  }
  return label;
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
  const labelWidth = Math.max(
    0,
    ...sorted.flatMap((result) =>
      visibleWindows(result).map((window) => windowLabel(window).length),
    ),
  );
  const lines: string[] = [];
  for (const result of sorted) {
    const headingColor =
      result.status === 'expired' ||
      result.status === 'unavailable' ||
      result.error?.code === 'logged_out_account'
        ? 'red'
        : result.status === 'stale'
          ? 'yellow'
          : 'green';
    const metadata = [
      tint(result.directoryName ?? `${result.provider}:${result.label}`, headingColor, color),
      result.plan ? tint(result.plan, 'dim', color) : undefined,
      tint(sourceLabel(result), headingColor, color && Boolean(sourceLabel(result))),
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(metadata);

    if (result.status === 'unavailable' || !result.windows.length) {
      lines.push(
        `  ${tint(result.error?.code === 'logged_out_account' ? 'Login needed. Sign in with the official provider CLI for this directory.' : (result.error?.message ?? 'Unavailable'), 'red', color)}`,
      );
    } else {
      const windows = visibleWindows(result).sort(windowOrder);
      const accountReached = windows.some(isReached);
      for (const window of windows) {
        const percent = Math.round(window.usedPercent);
        const reached = isReached(window);
        const barColor =
          reached || window.usedPercent >= 80
            ? 'red'
            : window.usedPercent >= 60
              ? 'yellow'
              : 'green';
        const suffix = reached ? '  LIMIT REACHED' : '';
        const reset = resetLabel(window, now, color);
        const plain =
          `  ${windowLabel(window).padEnd(labelWidth)}  ${quotaBar(window.usedPercent)}  ${String(percent).padStart(3)}% used  ${reset.formatted}${suffix}`.trimEnd();
        lines.push(
          accountReached
            ? tint(plain, 'red', color)
            : `  ${windowLabel(window).padEnd(labelWidth)}  ${tint(quotaBar(window.usedPercent), barColor, color)}  ${String(percent).padStart(3)}% used  ${reset.formatted}`,
        );
      }
    }
    if (result.credits) {
      const credits = result.credits;
      if (credits.available !== undefined) {
        lines.push(`  Reset credits: ${credits.available}`);
      }
      const rows = (credits.details ?? [])
        .filter((row) => 'expiresAt' in row || 'resetType' in row || 'status' in row)
        .map((row) => {
          const value = row.expiresAt;
          const expires =
            typeof value === 'number'
              ? value * 1_000
              : typeof value === 'string'
                ? Date.parse(value)
                : NaN;
          return { row, expires };
        })
        .sort(
          (a, b) =>
            (Number.isFinite(a.expires) ? a.expires : Infinity) -
            (Number.isFinite(b.expires) ? b.expires : Infinity),
        );
      for (const { row, expires } of rows) {
        const remaining = expires - now.getTime();
        const expiry = Number.isFinite(expires)
          ? `${remaining <= 0 ? `expired ${formatDuration(-remaining / 1_000)} ago` : `expires in ${formatDuration(remaining / 1_000)}`} (${new Intl.DateTimeFormat(
              undefined,
              {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              },
            ).format(new Date(expires))})`
          : row.expiresAt === null
            ? 'no expiration'
            : 'expiration unknown';
        const line = `  ${String(row.title ?? 'Reset credit')} ${expiry}${row.status && row.status !== 'available' ? ` ${row.status}` : ''}`;
        lines.push(tint(line, 'dim', color && !(remaining > 0 && remaining < 7 * 86_400_000)));
      }
      if (credits.balance !== undefined) {
        lines.push(`  Credits: ${credits.balance}${credits.unit ? ` ${credits.unit}` : ''}`);
      }
    }
    lines.push('');
  }
  if (!sorted.length && !errors.length)
    lines.push('No subscription directories or registered accounts found.');
  for (const error of errors) {
    const represented = sorted.some(
      (result) =>
        result.provider === error.provider &&
        result.label === error.accountLabel &&
        result.error?.code === error.code,
    );
    if (!represented) lines.push(tint(error.message, 'red', color));
  }
  return lines.join('\n').trimEnd();
}
