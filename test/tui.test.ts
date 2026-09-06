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
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?25h\u001b[?1049l');
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
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?25h\u001b[?1049l');
    expect(output.listenerCount('resize')).toBe(0);
  });
});
