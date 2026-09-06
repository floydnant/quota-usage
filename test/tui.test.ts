import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTui, useTui } from '../src/tui.js';
import type { CollectionSummary } from '../src/collect.js';

const summary: CollectionSummary = { results: [], errors: [], exitCode: 0 };
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isRaw: false,
    readableFlowing: null,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const output = Object.assign(new EventEmitter(), { rows: 24, columns: 100, write: vi.fn() });
  return {
    input,
    output,
    options: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      intervalMs: 60_000,
      color: 'never' as const,
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('foreground dashboard', () => {
  it('defaults to interactive terminals and keeps plain/JSON finite', () => {
    expect(useTui({}, true, true)).toBe(true);
    expect(useTui({}, false, true)).toBe(false);
    expect(useTui({}, true, false)).toBe(false);
    expect(useTui({ plain: true }, true, true)).toBe(false);
    expect(useTui({ json: true }, true, true)).toBe(false);
  });
  it('refreshes on schedule and manually, then restores terminal state', async () => {
    vi.useFakeTimers();
    const { input, output, options } = terminal();
    const collect = vi.fn().mockResolvedValue(summary);
    const running = runTui({ ...options, collect });
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).toHaveBeenCalledTimes(2);
    input.emit('data', Buffer.from('r'));
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(3);
    input.emit('data', Buffer.from('q'));
    expect(await running).toEqual(summary);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.listenerCount('data')).toBe(0);
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?2026l\u001b[?25h\u001b[?1049l');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never overlaps a slow refresh and drains it when quitting', async () => {
    vi.useFakeTimers();
    const { input, options } = terminal();
    let finish!: (value: CollectionSummary) => void;
    const collect = vi.fn(
      () =>
        new Promise<CollectionSummary>((resolve) => {
          finish = resolve;
        }),
    );
    const running = runTui({ ...options, collect });
    input.emit('data', Buffer.from('r'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(collect).toHaveBeenCalledOnce();
    input.emit('data', Buffer.from('q'));
    finish(summary);
    await running;
    expect(collect).toHaveBeenCalledOnce();
  });
  it('restores the terminal after a collection failure', async () => {
    const { input, output, options } = terminal();
    await expect(
      runTui({ ...options, collect: () => Promise.reject(new Error('failed')) }),
    ).rejects.toThrow('failed');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?2026l\u001b[?25h\u001b[?1049l');
    expect(output.listenerCount('resize')).toBe(0);
  });
  it('updates only the countdown row and skips unchanged frames without clearing the screen', async () => {
    vi.useFakeTimers();
    const { input, output, options } = terminal();
    const running = runTui({ ...options, collect: async () => summary });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      output.write.mock.calls.filter(([text]) => String(text).includes('\u001b[2J')),
    ).toHaveLength(1);
    output.write.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(output.write).toHaveBeenCalledExactlyOnceWith(
      '\u001b[?2026h\u001b[2;1HRefresh in 59s  |  r refresh · q quit · ↑/↓ scroll\u001b[0m\u001b[K\u001b[?2026l',
    );
    output.write.mockClear();
    input.emit('data', Buffer.from('k'));
    expect(output.write).not.toHaveBeenCalled();
    input.emit('data', Buffer.from('q'));
    await running;
  });

  it('erases shortened and removed rows, redraws on resize, and stays within short screens', async () => {
    vi.useFakeTimers();
    const { input, output, options } = terminal();
    const collect = vi
      .fn()
      .mockResolvedValueOnce({
        ...summary,
        errors: ['A long failure message', 'Another failure', 'Final failure'].map((message) => ({
          code: 'provider_failure',
          message,
          retryable: false,
        })),
      })
      .mockResolvedValue({
        ...summary,
        errors: [{ code: 'provider_failure', message: 'Short', retryable: false }],
      });
    const running = runTui({ ...options, collect });
    await vi.advanceTimersByTimeAsync(0);
    output.write.mockClear();
    input.emit('data', Buffer.from('r'));
    await vi.advanceTimersByTimeAsync(0);
    const changes = output.write.mock.calls.map(([text]) => String(text)).join('');
    expect(changes).toContain('\u001b[4;1HShort\u001b[0m\u001b[K');
    expect(changes).toContain('\u001b[6;1H\u001b[0m\u001b[K');
    expect(changes).toContain('\u001b[7;1H\u001b[0m\u001b[K');
    expect(changes).not.toContain('\u001b[2J');
    output.write.mockClear();
    output.rows = 2;
    output.columns = 12;
    output.emit('resize');
    expect(output.write).toHaveBeenCalledExactlyOnceWith(
      '\u001b[?2026h\u001b[1;1HQuota usage\u001b[0m\u001b[K\u001b[2;1HRefresh in \u001b[0m\u001b[K\u001b[?2026l',
    );
    output.write.mockClear();
    output.rows = 24;
    output.columns = 100;
    output.emit('resize');
    expect(String(output.write.mock.calls[0]?.[0])).toContain('\u001b[4;1HShort');
    expect(String(output.write.mock.calls[0]?.[0])).toContain('\u001b[6;1H\u001b[J');
    input.emit('data', Buffer.from('q'));
    await running;
  });

  it('ends every synchronized frame before waiting for collection or input', async () => {
    vi.useFakeTimers();
    const { input, output, options } = terminal();
    let finish!: (value: CollectionSummary) => void;
    const running = runTui({
      ...options,
      collect: () =>
        new Promise<CollectionSummary>((resolve) => {
          finish = resolve;
        }),
    });
    const expectCompleteFrames = () => {
      for (const [text] of output.write.mock.calls) {
        expect(String(text).startsWith('\u001b[?2026h')).toBe(true);
        expect(String(text).endsWith('\u001b[?2026l')).toBe(true);
      }
    };
    expectCompleteFrames();
    finish(summary);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expectCompleteFrames();
    input.emit('data', Buffer.from('q'));
    await running;
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?2026l\u001b[?25h\u001b[?1049l');
  });

  it('prints warnings once after restoring the terminal instead of scrolling the dashboard', async () => {
    vi.useFakeTimers();
    const { input, output, options } = terminal();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const collect = async (): Promise<CollectionSummary> => ({
      ...summary,
      results: [
        {
          provider: 'codex',
          label: 'work',
          source: 'codex-app-server',
          status: 'live',
          collectedAt: new Date().toISOString(),
          windows: [],
          warnings: ['Safe warning'],
        },
      ],
    });
    try {
      const running = runTui({ ...options, collect });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stderr).not.toHaveBeenCalled();
      input.emit('data', Buffer.from('q'));
      await running;
      expect(stderr).toHaveBeenCalledExactlyOnceWith('codex:work: Safe warning\n');
      expect(output.write.mock.invocationCallOrder.at(-1)).toBeLessThan(
        stderr.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
