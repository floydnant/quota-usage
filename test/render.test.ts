import { describe, expect, it } from 'vitest';
import { quotaBar, renderHuman } from '../src/render-human.js';
import { publicDocument, renderJson } from '../src/render-json.js';
import type { AccountResult, UsageErrorData } from '../src/types.js';

const result: AccountResult = {
  provider: 'codex',
  label: 'personal',
  plan: 'Plus',
  source: 'codex-app-server',
  status: 'live',
  collectedAt: '2026-08-27T18:00:00.000Z',
  windows: [
    {
      id: 'week',
      label: '7d',
      usedPercent: 61,
      remainingPercent: 39,
      durationSeconds: 604800,
      resetAt: '2026-08-31T18:00:00.000Z',
    },
    {
      id: 'session',
      label: '5h',
      usedPercent: 24,
      remainingPercent: 76,
      durationSeconds: 18000,
      resetAt: '2026-08-27T20:14:00.000Z',
    },
  ],
};

describe('rendering', () => {
  it('draws precise fixed-width bars and sorts shorter windows first without color', () => {
    expect(quotaBar(0)).toBe('[░░░░░░░░░░░░░░░░░░░░]');
    expect(quotaBar(3)).toBe('[▋░░░░░░░░░░░░░░░░░░░]');
    expect(quotaBar(24)).toBe('[████▊░░░░░░░░░░░░░░░]');
    expect(quotaBar(100)).toBe('[████████████████████]');
    const text = renderHuman([result], [], {
      color: 'never',
      now: new Date('2026-08-27T18:00:00Z'),
    });
    expect(text).not.toContain('\u001b[');
    expect(text.indexOf('5h')).toBeLessThan(text.indexOf('7d'));
    expect(text).toContain('24% used');
    expect(text).toMatch(/resets .+ at \d{2}:\d{2} {2}\(in 4d\)/);
  });

  it('aligns bars and percentages within an account', () => {
    const week = result.windows[0];
    const session = result.windows[1];
    if (!week || !session) throw new Error('fixture windows are missing');
    const mixedLabels: AccountResult = {
      ...result,
      windows: [
        { ...week, label: '7d', usedPercent: 9 },
        { ...session, label: 'GPT-5.3-Codex-Spark', usedPercent: 100 },
      ],
    };
    const lines = renderHuman([mixedLabels], [], {
      color: 'never',
      now: new Date('2026-08-27T18:00:00Z'),
    }).split('\n');
    const windowLines = lines.slice(1);
    expect(windowLines).toHaveLength(2);
    expect(windowLines.map((line) => line.indexOf('['))).toEqual([23, 23]);
    expect(windowLines.map((line) => line.indexOf('% used'))).toEqual([50, 50]);
    expect(windowLines.join('\n')).toContain('  9% used');
    expect(windowLines.join('\n')).toContain('100% used');
  });

  it('uses thresholds, honors NO_COLOR, and labels reached limits', () => {
    const baseWindow = result.windows[0];
    if (!baseWindow) throw new Error('fixture window is missing');
    const reached = {
      ...result,
      windows: [{ ...baseWindow, usedPercent: 100, reached: true }],
    };
    expect(renderHuman([reached], [], { color: 'always', env: {}, now: new Date() })).toContain(
      '\u001b[31m',
    );
    expect(
      renderHuman([reached], [], { color: 'always', env: { NO_COLOR: '' }, now: new Date() }),
    ).not.toContain('\u001b[');
    expect(renderHuman([reached], [], { color: 'never', now: new Date() })).toContain(
      'LIMIT REACHED',
    );
    expect(
      renderHuman([result], [], {
        color: 'always',
        env: {},
        now: new Date('2026-08-27T18:00:00Z'),
      }),
    ).toContain('\u001b[1mresets');
  });

  it('does not draw a fake unavailable bar', () => {
    const unavailable: AccountResult = {
      provider: 'claude',
      label: 'x',
      source: 'unavailable',
      status: 'unavailable',
      collectedAt: new Date().toISOString(),
      windows: [],
      error: {
        code: 'missing_cache',
        message: 'No cache',
        provider: 'claude',
        accountLabel: 'x',
        retryable: false,
      },
    };
    const text = renderHuman([unavailable], [], { color: 'never' });
    expect(text).toContain('Claude  x  unavailable');
    expect(text).not.toContain('unavailable 0s ago');
    expect(text).toContain('No cache');
    expect(text).not.toContain(quotaBar(0));
  });

  it('emits exactly one versioned JSON document with stable errors', () => {
    const errors: UsageErrorData[] = [
      {
        code: 'timeout',
        message: 'timed out',
        provider: 'codex',
        accountLabel: 'personal',
        retryable: true,
      },
    ];
    const text = renderJson(
      publicDocument('live', [result], errors, new Date('2026-08-27T18:40:00Z')),
    );
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      mode: 'live',
      errors: [{ code: 'timeout' }],
    });
    expect(text.trim().startsWith('{')).toBe(true);
  });
});
