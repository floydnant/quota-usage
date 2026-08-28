import { UsageError } from '../errors.js';
import { compareVersions, parseVersion, vendorEnvironment } from '../executable.js';
import { ProcessTracker, runProcess } from '../processes.js';
import { constants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
  AccountConfig,
  AccountResult,
  CollectionOptions,
  ProviderAdapter,
  QuotaWindow,
} from '../types.js';

export const MIN_CLAUDE_MULTI_ACCOUNT_VERSION = '2.1.238';

export interface NodePtyHelperStatus {
  path: string;
  mode: number;
  executable: boolean;
}

function nodePtyPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('node-pty/package.json'));
}

export async function nodePtyHelperStatus(
  packageRoot = nodePtyPackageRoot(),
): Promise<NodePtyHelperStatus | undefined> {
  const directories = [
    join(packageRoot, 'build', 'Release'),
    join(packageRoot, 'build', 'Debug'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`),
  ];
  for (const directory of directories) {
    const nativeModule = join(directory, 'pty.node');
    const helper = join(directory, 'spawn-helper');
    if (
      !(await access(nativeModule).then(
        () => true,
        () => false,
      ))
    )
      continue;
    const info = await stat(helper).catch(() => undefined);
    if (!info?.isFile()) continue;
    return {
      path: helper,
      mode: info.mode & 0o777,
      executable: await access(helper, constants.X_OK).then(
        () => true,
        () => false,
      ),
    };
  }
  return undefined;
}

export async function ensureNodePtyHelperExecutable(
  packageRoot?: string,
): Promise<NodePtyHelperStatus> {
  const status = await nodePtyHelperStatus(packageRoot);
  if (!status) {
    throw new UsageError('provider_failure', 'node-pty spawn-helper was not found', {
      provider: 'claude',
    });
  }
  if (!status.executable) {
    try {
      await chmod(status.path, status.mode | 0o111);
    } catch (error) {
      throw new UsageError(
        'provider_failure',
        `node-pty spawn-helper is not executable: ${status.path}`,
        { provider: 'claude', cause: error },
      );
    }
  }
  return {
    ...status,
    mode: status.mode | 0o111,
    executable: true,
  };
}

export interface PtyProcess {
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: () => void): { dispose(): void };
  write(data: string): void;
  kill(signal?: string): void;
  readonly pid: number;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): PtyProcess;
}

interface TerminalDisposable {
  dispose(): void;
}

interface HeadlessTerminal {
  onData(callback: (data: string) => void): TerminalDisposable;
  onBinary(callback: (data: string) => void): TerminalDisposable;
  write(data: string): void;
  input(data: string, wasUserInput?: boolean): void;
  dispose(): void;
}

type HeadlessTerminalConstructor = new (options: {
  cols: number;
  rows: number;
  scrollback: number;
  allowProposedApi: boolean;
  theme: { background: string };
}) => HeadlessTerminal;

async function loadHeadlessTerminal(): Promise<HeadlessTerminalConstructor> {
  try {
    const imported = await import('@xterm/headless');
    const module = (imported as { default?: unknown }).default ?? imported;
    const Terminal = (module as { Terminal?: HeadlessTerminalConstructor }).Terminal;
    if (!Terminal) throw new Error('Terminal export is missing');
    return Terminal;
  } catch (error) {
    throw new UsageError(
      'provider_failure',
      '@xterm/headless could not load; Claude live collection is unavailable',
      { provider: 'claude', cause: error },
    );
  }
}

function cleanTerminal(value: string): string {
  /* eslint-disable no-control-regex -- terminal escape sequences are the data being removed */
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  /* eslint-enable no-control-regex */
}

function safeUiSignals(value: string): string {
  const text = cleanTerminal(value);
  const signals: Array<[string, RegExp]> = [
    ['claude-code', /claude code/i],
    ['welcome', /welcome/i],
    ['command-echo', /\/usage/i],
    ['usage', /\busage\b/i],
    ['plan-usage', /plan usage/i],
    ['current-session', /current session/i],
    ['weekly', /weekly/i],
    ['login', /log in|sign in|authentication required/i],
    ['trust', /trust (?:this|the)|do you trust/i],
    ['theme', /theme/i],
    ['update', /upgrade required|update available|new version/i],
    ['network-error', /network error|connection (?:failed|error)|unable to connect/i],
  ];
  const found = signals.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return found.length ? found.join(',') : 'none';
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function datePartsInZone(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
  };
}

function dateInZone(parts: LocalDateParts, timeZone: string): Date {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let timestamp = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = datePartsInZone(new Date(timestamp), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    timestamp += desired - represented;
  }
  return new Date(timestamp);
}

function parseClaudeLocalReset(text: string, now: Date): Date | undefined {
  const match =
    /reset(?:s|ting)?\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^)]+)\))?/i.exec(
      text,
    );
  if (!match) return undefined;
  const timeZone = match[7] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const current = datePartsInZone(now, timeZone);
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    let hour = Number(match[4]);
    if (match[6]?.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (match[6]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    const month = match[1] ? months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1 : current.month;
    const day = match[2] ? Number(match[2]) : current.day;
    let year = match[3] ? Number(match[3]) : current.year;
    let result = dateInZone({ year, month, day, hour, minute: Number(match[5] ?? 0) }, timeZone);
    if (result.getTime() <= now.getTime() && !match[3]) {
      if (match[1]) year += 1;
      else {
        const next = new Date(Date.UTC(year, month - 1, day + 1));
        year = next.getUTCFullYear();
        return dateInZone(
          {
            year,
            month: next.getUTCMonth() + 1,
            day: next.getUTCDate(),
            hour,
            minute: Number(match[5] ?? 0),
          },
          timeZone,
        );
      }
      result = dateInZone({ year, month, day, hour, minute: Number(match[5] ?? 0) }, timeZone);
    }
    return result;
  } catch {
    return undefined;
  }
}

function parseReset(text: string, now: Date): string | null {
  const unix = /\b(1\d{9})\b/.exec(text)?.[1];
  if (unix) return new Date(Number(unix) * 1_000).toISOString();
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/.exec(
    text,
  )?.[0];
  if (iso) return new Date(iso).toISOString();
  const local = parseClaudeLocalReset(text, now);
  if (local) return local.toISOString();
  const explicit = Date.parse(text.replace(/^.*?reset(?:s|ting)?(?: at| on| in)?\s*/i, ''));
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
  const relative = /reset(?:s|ting)? in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/i.exec(text);
  if (relative) {
    const seconds =
      Number(relative[1] ?? 0) * 86_400 +
      Number(relative[2] ?? 0) * 3_600 +
      Number(relative[3] ?? 0) * 60;
    return new Date(now.getTime() + seconds * 1_000).toISOString();
  }
  return null;
}

export function parseClaudeUsageScreen(
  raw: string,
  account: Pick<AccountConfig, 'label'>,
  now = new Date(),
): AccountResult {
  const text = cleanTerminal(raw).replace(/\r/g, '');
  if (/log in|sign in|authentication required/i.test(text)) {
    throw new UsageError('logged_out_account', `Claude account ${account.label} is logged out`, {
      provider: 'claude',
      accountLabel: account.label,
    });
  }
  if (/trust (?:this|the) (?:folder|directory)|do you trust/i.test(text)) {
    throw new UsageError('provider_failure', 'Claude displayed a workspace trust prompt', {
      provider: 'claude',
      accountLabel: account.label,
    });
  }
  if (/network error|connection (?:failed|error)|unable to connect/i.test(text)) {
    throw new UsageError('provider_failure', 'Claude reported a network error', {
      provider: 'claude',
      accountLabel: account.label,
      retryable: true,
    });
  }
  if (/upgrade required|update available|new version (?:is )?available/i.test(text)) {
    throw new UsageError('provider_failure', 'Claude displayed an upgrade notice', {
      provider: 'claude',
      accountLabel: account.label,
    });
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const windows: QuotaWindow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /(?:^|\s)(\d+(?:\.\d+)?)\s*%\s*(?:used)?/i.exec(line);
    if (!match) continue;
    const context = `${lines[index - 1] ?? ''} ${line} ${lines[index + 1] ?? ''}`;
    let id: string;
    let durationSeconds: number | undefined;
    if (/7\s*(?:d|day)|week(?:ly)?/i.test(line)) {
      id = 'seven_day';
      durationSeconds = 7 * 86_400;
    } else if (/5\s*(?:h|hour)|current session/i.test(line)) {
      id = 'five_hour';
      durationSeconds = 5 * 3_600;
    } else if (/7\s*(?:d|day)|week(?:ly)?/i.test(context)) {
      id = 'seven_day';
      durationSeconds = 7 * 86_400;
    } else if (/5\s*(?:h|hour)|current session/i.test(context)) {
      id = 'five_hour';
      durationSeconds = 5 * 3_600;
    } else {
      id = `window_${windows.length + 1}`;
    }
    if (windows.some((window) => window.id === id)) continue;
    const used = Number(match[1]);
    const resetAt = parseReset(context, now);
    windows.push({
      id,
      label: id === 'five_hour' ? '5h' : id === 'seven_day' ? '7d' : id,
      usedPercent: used,
      remainingPercent: Math.min(100, Math.max(0, 100 - used)),
      resetOriginal: /reset/i.test(context) ? context.slice(0, 300) : null,
      resetAt,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      reached: used >= 100 || /limit reached|blocked/i.test(context),
    });
  }
  if (!windows.length) {
    throw new UsageError(
      'parse_failure',
      'Claude /usage output did not contain recognizable quota windows',
      {
        provider: 'claude',
        accountLabel: account.label,
      },
    );
  }
  const plan = /\b(Max|Pro|Team|Enterprise)\b/i.exec(text)?.[1];
  const extraUsage =
    /(?:paid )?extra usage[^\n]*(?:balance|remaining)[^\d$€£]*([$€£]?\s*\d+(?:\.\d+)?)/i.exec(
      text,
    )?.[1];
  return {
    provider: 'claude',
    label: account.label,
    ...(plan ? { plan } : {}),
    source: 'claude-tui',
    status: 'live',
    collectedAt: now.toISOString(),
    windows,
    ...(extraUsage ? { credits: { balance: extraUsage.replaceAll(' ', '') } } : {}),
  };
}

export class ClaudeLiveAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;
  private ptyModule: PtyModule | undefined;

  constructor(
    private readonly executable: string,
    private readonly tracker: ProcessTracker,
    ptyModule?: PtyModule,
  ) {
    this.ptyModule = ptyModule;
  }

  async version(timeoutMs = 2_000): Promise<string> {
    const result = await runProcess(this.executable, ['--version'], {
      timeoutMs,
      tracker: this.tracker,
    });
    const version = parseVersion(result.stdout);
    if (!version || compareVersions(version, MIN_CLAUDE_MULTI_ACCOUNT_VERSION) < 0) {
      throw new UsageError(
        'unsupported_vendor_version',
        `Claude Code ${version ?? 'unknown'} is unsupported for managed multi-account use; ${MIN_CLAUDE_MULTI_ACCOUNT_VERSION} or newer is required`,
        { provider: 'claude' },
      );
    }
    return version;
  }

  async loadPty(): Promise<PtyModule> {
    if (this.ptyModule) return this.ptyModule;
    try {
      await ensureNodePtyHelperExecutable();
      this.ptyModule = await import('node-pty');
      return this.ptyModule;
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(
        'provider_failure',
        'node-pty could not load; Claude live collection is unavailable',
        {
          provider: 'claude',
          cause: error,
        },
      );
    }
  }

  async collect(account: AccountConfig, options: CollectionOptions): Promise<AccountResult> {
    const startedAt = Date.now();
    const version = await this.version();
    options.verbose?.(`claude:${account.label}: version ${version}`);
    const pty = await this.loadPty();
    const Terminal = await loadHeadlessTerminal();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      vendorEnvironment('claude', account.stateDir, process.env, {
        claudeDefault: account.claudeDefault,
      }),
    ))
      if (value !== undefined) env[key] = value;
    env.TERM = 'xterm-256color';
    const child = pty.spawn(this.executable, ['--ax-screen-reader'], {
      cols: 100,
      rows: 32,
      cwd: process.cwd(),
      env,
    });
    const terminal = new Terminal({
      cols: 100,
      rows: 32,
      scrollback: 2_000,
      allowProposedApi: true,
      theme: { background: '#000000' },
    });
    const terminalDataListener = terminal.onData((data) => child.write(data));
    const terminalBinaryListener = terminal.onBinary((data) => child.write(data));
    options.verbose?.(`claude:${account.label}: PTY started pid=${child.pid}`);
    let resolveExit: (() => void) | undefined;
    let didExit = false;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const exitListener = child.onExit(() => {
      didExit = true;
      resolveExit?.();
    });
    const owned = this.tracker.track({
      pid: child.pid,
      kill: (signal) => {
        if (!didExit) child.kill(signal);
      },
      exited,
    });
    let buffer = '';
    let chunks = 0;
    let sawOutput = false;
    let sawReadiness = false;
    let sent = false;
    let sendTimer: NodeJS.Timeout | undefined;
    let answeredBackgroundQuery = false;
    let answeredVersionQuery = false;
    let rejectedProviderState = false;
    let rejectProviderState: ((error: UsageError) => void) | undefined;
    const providerState = new Promise<never>((_, reject) => {
      rejectProviderState = reject;
    });
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const dataListener = child.onData((data) => {
      chunks += 1;
      if (!sawOutput) {
        sawOutput = true;
        options.verbose?.(`claude:${account.label}: PTY produced output`);
      }
      buffer = `${buffer}${data}`.slice(-256 * 1024);
      terminal.write(data);
      if (!answeredBackgroundQuery && buffer.includes('\u001b]11;?')) {
        answeredBackgroundQuery = true;
        child.write('\u001b]11;rgb:0000/0000/0000\u001b\\');
      }
      if (!answeredVersionQuery && buffer.includes('\u001b[>0q')) {
        answeredVersionQuery = true;
        child.write('\u001bP>|xterm.js(6.0.0)\u001b\\');
      }
      const screen = cleanTerminal(buffer);
      const rejectState = (message: string, code: 'logged_out_account' | 'provider_failure') => {
        if (rejectedProviderState) return;
        rejectedProviderState = true;
        rejectProviderState?.(
          new UsageError(code, message, {
            provider: 'claude',
            accountLabel: account.label,
          }),
        );
      };
      if (/choose the text style|enter selection \[1-7\]/i.test(screen)) {
        rejectState(
          `Claude first-run setup is incomplete for ${account.label}; run the official Claude TUI once for this account`,
          'provider_failure',
        );
      } else if (
        /select login method|open your browser|verification code|setup token/i.test(screen)
      ) {
        rejectState(
          `Claude account ${account.label} requires official login setup`,
          'logged_out_account',
        );
      } else if (/trust (?:this|the) (?:folder|directory)|do you trust/i.test(screen)) {
        rejectState('Claude displayed a workspace trust prompt', 'provider_failure');
      } else if (/network error|connection (?:failed|error)|unable to connect/i.test(screen)) {
        rejectState('Claude reported a network error', 'provider_failure');
      } else if (/upgrade required|update available|new version (?:is )?available/i.test(screen)) {
        rejectState('Claude displayed an upgrade notice', 'provider_failure');
      }
      if (!rejectedProviderState && !sent) {
        if (
          !sawReadiness &&
          /(?:type \/ for commands|what can i help|❯|claude code v\d)/i.test(screen)
        ) {
          sawReadiness = true;
          options.verbose?.(`claude:${account.label}: semantic readiness detected`);
        }
        if (sawReadiness) {
          if (sendTimer) clearTimeout(sendTimer);
          sendTimer = setTimeout(() => {
            sent = true;
            options.verbose?.(`claude:${account.label}: input settled; sending /usage`);
            terminal.input('/usage\r');
          }, 400);
        }
      }
      if (
        sent &&
        /(?:current session|five.hour|5h|seven.day|weekly|plan usage)/i.test(cleanTerminal(buffer))
      ) {
        options.verbose?.(`claude:${account.label}: quota screen detected`);
        resolveReady?.();
      }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        providerState,
        exited.then(() => {
          throw new UsageError('provider_failure', 'Claude exited before /usage completed', {
            provider: 'claude',
            accountLabel: account.label,
          });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            options.verbose?.(
              `claude:${account.label}: timeout phase=${sent ? 'waiting-for-usage' : sawReadiness ? 'waiting-for-input-settle' : sawOutput ? 'waiting-for-readiness' : 'waiting-for-output'} chunks=${chunks} bytes=${Buffer.byteLength(buffer)} uiSignals=${safeUiSignals(buffer)} elapsedMs=${Date.now() - startedAt}`,
            );
            reject(
              new UsageError('timeout', `Claude live check timed out for ${account.label}`, {
                provider: 'claude',
                accountLabel: account.label,
              }),
            );
          }, options.timeoutMs);
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return parseClaudeUsageScreen(buffer, account, options.now ?? new Date());
    } finally {
      if (timer) clearTimeout(timer);
      if (sendTimer) clearTimeout(sendTimer);
      terminal.input('\u001b');
      await new Promise((resolve) => setTimeout(resolve, 50));
      terminal.input('/exit\r');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 300))]);
      const hasExited = (): boolean => didExit;
      if (!hasExited()) child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 200))]);
      if (!hasExited()) child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      this.tracker.untrack(owned);
      options.verbose?.(`claude:${account.label}: PTY cleanup complete`);
      dataListener.dispose();
      exitListener.dispose();
      terminalDataListener.dispose();
      terminalBinaryListener.dispose();
      terminal.dispose();
    }
  }
}
