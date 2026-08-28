import { UsageError } from './errors.js';

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    throw new UsageError('invalid_configuration', `Invalid duration "${value}"`);
  }
  const amount = Number(match[1]);
  const multiplier = UNITS[match[2] ?? ''];
  if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) {
    throw new UsageError('invalid_configuration', `Invalid duration "${value}"`);
  }
  return Math.round(amount * multiplier);
}

export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  const secs = value % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && parts.length < 2) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${secs}s`);
  return parts.slice(0, 2).join(' ');
}
