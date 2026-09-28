import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { UsageError } from './errors.js';
import { killOwnedTree, spawnExecutable } from './platform.js';

export interface OwnedProcess {
  pid?: number | undefined;
  /** May return a promise that settles when the kill operation has finished. */
  kill(signal?: NodeJS.Signals): unknown;
  exited?: Promise<unknown>;
}

const settled = (value: unknown): Promise<void> =>
  Promise.resolve(value).then(
    () => undefined,
    () => undefined,
  );

export class ProcessTracker {
  private readonly owned = new Set<OwnedProcess>();
  private cleaning = false;

  track<T extends OwnedProcess>(process: T): T {
    this.owned.add(process);
    void process.exited?.then(
      () => this.owned.delete(process),
      () => this.owned.delete(process),
    );
    return process;
  }

  untrack(process: OwnedProcess): void {
    this.owned.delete(process);
  }

  get size(): number {
    return this.owned.size;
  }

  async cleanup(graceMs = 500): Promise<void> {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const processes = [...this.owned];
      // Windows tree kills run as their own taskkill processes; drain them too.
      const kills = processes.map((process) => settled(process.kill('SIGTERM')));
      await Promise.all(
        processes.map(async (process) => {
          if (!process.exited) return;
          await Promise.race([
            process.exited.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, graceMs)),
          ]);
        }),
      );
      for (const process of processes) {
        if (this.owned.has(process)) kills.push(settled(process.kill('SIGKILL')));
      }
      await Promise.all([
        ...kills,
        ...processes.flatMap((process) =>
          process.exited ? [process.exited.catch(() => undefined)] : [],
        ),
      ]);
      for (const process of processes) this.owned.delete(process);
    } finally {
      this.cleaning = false;
    }
  }

  installSignalHandlers(onSignal?: (signal: NodeJS.Signals) => void): () => void {
    const handler = (signal: NodeJS.Signals): void => {
      onSignal?.(signal);
      void this.cleanup().finally(() => {
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
      });
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runProcess(
  executable: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs: number;
    tracker: ProcessTracker;
    input?: string;
    maxOutput?: number;
  },
): Promise<RunResult> {
  const child = spawnExecutable(executable, args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const exited = once(child, 'exit');
  options.tracker.track({
    pid: child.pid,
    kill: (signal) => killOwnedTree(child, signal),
    exited,
  });
  let stdout = '';
  let stderr = '';
  const max = options.maxOutput ?? 1024 * 1024;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-max);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-max);
  });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timeoutKill: Promise<void> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timeoutKill = killOwnedTree(child, 'SIGTERM');
      reject(
        new UsageError('timeout', `Process timed out after ${options.timeoutMs}ms`, {
          retryable: true,
        }),
      );
    }, options.timeoutMs);
  });
  try {
    const [code] = (await Promise.race([exited, timeoutPromise])) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { stdout, stderr, code: code ?? 1 };
  } catch (error) {
    const forced = killOwnedTree(child, 'SIGKILL');
    await Promise.all([exited.catch(() => undefined), timeoutKill, forced]);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function childOwned(child: ChildProcess): OwnedProcess {
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    kill: (signal) => killOwnedTree(child, signal),
    exited: once(child, 'exit'),
  };
}
