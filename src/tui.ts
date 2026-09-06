import { stripVTControlCharacters } from 'node:util';
import type { CollectionSummary } from './collect.js';
import { renderHuman, type ColorMode } from './render-human.js';

export function useTui(
  options: { tui?: boolean; plain?: boolean; json?: boolean },
  inputTTY: boolean,
  outputTTY: boolean,
): boolean {
  return !options.json && !options.plain && inputTTY && outputTTY;
}

/** Foreground dashboard. Collections never overlap; quitting drains the current check. */
export async function runTui(options: {
  collect: () => Promise<CollectionSummary>;
  intervalMs: number;
  color: ColorMode;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<CollectionSummary | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const seenWarnings = new Set<string>();
  let summary: CollectionSummary | undefined;
  const state = { stopped: false };
  const isStopped = (): boolean => state.stopped;
  let refreshing = false;
  let nextRefresh = 0;
  let offset = 0;
  let wake: (() => void) | undefined;
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  const draw = (): void => {
    const now = new Date();
    const body = summary
      ? renderHuman(summary.results, summary.errors, {
          color: options.color,
          tty: true,
          now,
        })
      : 'Loading usage…';
    const lines = body.split('\n');
    const height = Math.max(1, (output.rows || 24) - 4);
    offset = Math.min(offset, Math.max(0, lines.length - height));
    const status = isStopped()
      ? 'Finishing current check…'
      : refreshing
        ? 'Refreshing…'
        : `Refresh in ${Math.max(0, Math.ceil((nextRefresh - Date.now()) / 1_000))}s`;
    const frame = [
      'Quota usage',
      `${status}  |  r refresh · q quit · ↑/↓ scroll`,
      '',
      ...lines.slice(offset, offset + height),
      `Rows ${offset + 1}–${Math.min(offset + height, lines.length)} of ${lines.length}`,
    ];
    // Keep each physical row within the viewport, including on narrow terminals.
    const width = Math.max(1, (output.columns || 80) - 1);
    output.write(
      `\u001b[H\u001b[2J${frame
        .map((line) => {
          const plain = stripVTControlCharacters(line);
          const characters = Array.from(
            new Intl.Segmenter().segment(plain),
            (part) => part.segment,
          );
          const prefix = line.slice(0, line.indexOf(plain[0] ?? ''));
          return characters.length > width
            ? `${prefix}${characters.slice(0, width).join('')}${prefix ? '\u001b[0m' : ''}`
            : line;
        })
        .join('\r\n')}`,
    );
  };
  const stop = (): void => {
    state.stopped = true;
    wake?.();
    draw();
  };
  const onData = (data: Buffer): void => {
    const key = data.toString();
    if (key.includes('q') || key.includes('\u0003') || key.includes('\u0004')) stop();
    else if (key === 'r' || key === 'R') {
      nextRefresh = 0;
      wake?.();
    } else if (key === '\u001b[B' || key === 'j') {
      offset += 1;
      draw();
    } else if (key === '\u001b[A' || key === 'k') {
      offset = Math.max(0, offset - 1);
      draw();
    }
  };
  try {
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('end', stop);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    output.on('resize', draw);
    output.write('\u001b[?1049h\u001b[?25l');
    while (!isStopped()) {
      refreshing = true;
      draw();
      summary = await options.collect();
      for (const result of summary.results) {
        for (const warning of result.warnings ?? []) {
          const message = `${result.provider}:${result.label}: ${warning}`;
          if (!seenWarnings.has(message)) process.stderr.write(`${message}\n`);
          seenWarnings.add(message);
        }
      }
      refreshing = false;
      nextRefresh = Date.now() + options.intervalMs;
      while (!isStopped() && Date.now() < nextRefresh) {
        draw();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              wake = undefined;
              resolve();
            },
            Math.min(1_000, nextRefresh - Date.now()),
          );
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      }
    }
    return summary;
  } finally {
    wake?.();
    input.off('data', onData);
    input.off('end', stop);
    output.off('resize', draw);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    input.setRawMode(wasRaw);
    if (wasFlowing !== true) input.pause();
    output.write('\u001b[?25h\u001b[?1049l');
  }
}
