import { describe, expect, it } from 'vitest';
import {
  identityHash,
  maskEmail,
  normalizeCodexRateLimits,
  normalizeEmail,
} from '../src/providers/codex.js';
import { extractClaudeStatusLine, parseClaudeStatusLine } from '../src/providers/claude-cache.js';
import { parseClaudeUsageScreen } from '../src/providers/claude-live.js';

describe('Codex normalization and identity', () => {
  it('normalizes every bucket and both active windows', () => {
    const result = normalizeCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            planType: 'plus',
            primary: { usedPercent: 24.5, windowDurationMins: 300, resetsAt: 1787875200 },
            secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1788000000 },
            rateLimitReachedType: null,
          },
          other: {
            limitId: 'other',
            limitName: 'Review',
            primary: { usedPercent: 101, windowDurationMins: 60, resetsAt: 1787900000 },
          },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [{ id: 'safe', status: 'available' }],
        },
      },
      { label: 'personal' },
      new Date('2026-08-27T18:00:00.000Z'),
    );
    expect(result.windows).toHaveLength(3);
    expect(result.windows[0]).toMatchObject({
      usedPercent: 24.5,
      remainingPercent: 75.5,
      durationSeconds: 18_000,
    });
    expect(result.windows[2]).toMatchObject({
      label: 'Review',
      remainingPercent: 0,
      reached: true,
    });
    expect(result).toMatchObject({ plan: 'plus', credits: { available: 2 } });
  });

  it('handles legacy bucket and rejects invalid responses', () => {
    expect(
      normalizeCodexRateLimits(
        { rateLimits: { limitId: 'legacy', primary: { usedPercent: 1 } } },
        { label: 'x' },
      ).windows[0]?.id,
    ).toBe('legacy:primary');
    expect(() => normalizeCodexRateLimits({}, { label: 'x' })).toThrow('no quota buckets');
    expect(() => normalizeCodexRateLimits({ rateLimits: { primary: {} } }, { label: 'x' })).toThrow(
      'usedPercent',
    );
  });

  it('normalizes, hashes, and masks email without exposing it', () => {
    expect(normalizeEmail(' User@Example.COM ')).toBe('user@example.com');
    expect(identityHash('User@example.com')).toBe(identityHash('user@example.com'));
    expect(maskEmail('user@example.com')).toBe('u***@example.com');
  });
});

describe('Claude parsing', () => {
  it('extracts all status-line rate limit keys and ignores unrelated data', () => {
    const result = extractClaudeStatusLine(
      {
        session_id: 'secret-session',
        context_window: { used_percentage: 99 },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1787875200 },
          seven_day: { used_percentage: 41.2, resets_at: null },
          special_window: { used_percentage: 7, resets_at: '2026-08-29T00:00:00Z' },
        },
      },
      { label: 'work' },
      new Date('2026-08-27T18:00:00Z'),
    );
    expect(result?.windows).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('secret-session');
  });

  it('returns undefined when no quota exists and rejects malformed JSON', () => {
    expect(
      extractClaudeStatusLine({ context_window: { used_percentage: 50 } }, { label: 'x' }),
    ).toBeUndefined();
    expect(extractClaudeStatusLine(null, { label: 'x' })).toBeUndefined();
    expect(extractClaudeStatusLine([], { label: 'x' })).toBeUndefined();
    expect(extractClaudeStatusLine({ rate_limits: [] }, { label: 'x' })).toBeUndefined();
    expect(
      extractClaudeStatusLine(
        {
          rate_limits: {
            bad: null,
            nan: { used_percentage: Number.NaN },
            invalid: { used_percentage: 1, resets_at: 'not-a-date' },
            reached: { used_percentage: 110 },
          },
        },
        { label: 'x' },
      )?.windows,
    ).toMatchObject([
      { id: 'invalid', resetAt: null },
      { id: 'reached', reached: true },
    ]);
    expect(
      parseClaudeStatusLine(
        JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1 } } }),
        { label: 'x' },
      )?.windows[0],
    ).not.toHaveProperty('resetAt');
    expect(() => parseClaudeStatusLine('{', { label: 'x' })).toThrow('invalid JSON');
  });

  it('semantically parses live usage and alternate screens', () => {
    const result = parseClaudeUsageScreen(
      `Claude Code Max\nPlan usage\nCurrent session (5 hour) 82% used resets in 47m\nWeekly (7 day) 39% used resets in 3d 8h`,
      { label: 'work' },
      new Date('2026-08-27T18:00:00Z'),
    );
    expect(result).toMatchObject({ plan: 'Max', status: 'live' });
    expect(result.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    const currentLayout = parseClaudeUsageScreen(
      `Claude Code Pro\nCurrent session\n4% 4% used\nResets 5:20am (Europe/Berlin)\nCurrent week (all models)\n13% 13% used\nResets Sep 1 at 3am (Europe/Berlin)`,
      { label: 'work' },
      new Date('2026-08-28T18:00:00Z'),
    );
    expect(currentLayout.windows).toMatchObject([
      { id: 'five_hour', resetAt: '2026-08-29T03:20:00.000Z' },
      { id: 'seven_day', resetAt: '2026-09-01T01:00:00.000Z' },
    ]);
    const absoluteReset = parseClaudeUsageScreen(
      `Current session\n1% used\nResets 12:00pm (UTC)\nCurrent week\n2% used\nResets Sep 1, 2027 at 12am (UTC)`,
      { label: 'work' },
      new Date('2026-08-28T10:00:00Z'),
    );
    expect(absoluteReset.windows).toMatchObject([
      { resetAt: '2026-08-28T12:00:00.000Z' },
      { resetAt: '2027-09-01T00:00:00.000Z' },
    ]);
    const invalidZone = parseClaudeUsageScreen(
      'Current session 5h 1% used resets 5am (Not/A_Zone)',
      { label: 'work' },
      new Date('2026-08-28T00:00:00Z'),
    );
    expect(invalidZone.windows[0]?.resetAt).toBeNull();
    expect(() => parseClaudeUsageScreen('Please log in to Claude Code', { label: 'x' })).toThrow(
      'logged out',
    );
    expect(() => parseClaudeUsageScreen('Do you trust this folder?', { label: 'x' })).toThrow(
      'trust prompt',
    );
    expect(() =>
      parseClaudeUsageScreen('Network error: unable to connect', { label: 'x' }),
    ).toThrow('network error');
    expect(() =>
      parseClaudeUsageScreen('Update available: new version is available', { label: 'x' }),
    ).toThrow('upgrade notice');
    expect(() => parseClaudeUsageScreen('Usage has changed completely', { label: 'x' })).toThrow(
      'recognizable quota windows',
    );
    const generic = parseClaudeUsageScreen(
      '\u001b[31mPlan usage\u001b[0m\nSpecial allocation 12% used reset at 2026-08-30T12:00:00Z\nSpecial allocation 12% used\nBlocked allocation 99% used limit reached',
      { label: 'x' },
    );
    expect(generic.windows[0]).toMatchObject({
      id: 'window_1',
      resetAt: '2026-08-30T12:00:00.000Z',
    });
    expect(generic.windows[0]).not.toHaveProperty('durationSeconds');
    expect(generic.windows[2]).toMatchObject({ id: 'window_3', reached: true });
    const unix = parseClaudeUsageScreen('Current session 5h 1% used resets 1787875200', {
      label: 'x',
    });
    expect(unix.windows[0]?.resetAt).toBe(new Date(1787875200 * 1000).toISOString());
    const credits = parseClaudeUsageScreen(
      'Claude Pro\nCurrent session 5h 1% used\nExtra usage balance remaining: $12.50',
      { label: 'x' },
    );
    expect(credits.credits).toEqual({ balance: '$12.50' });
  });
});
