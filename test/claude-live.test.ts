import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeLiveAdapter,
  parseClaudePrintResult,
  parseClaudeUsageText,
} from '../src/providers/claude-live.js';
import { ProcessTracker } from '../src/processes.js';
import type { AccountConfig } from '../src/types.js';

const account: AccountConfig = {
  provider: 'claude',
  label: 'work',
  stateDir: '/tmp/claude-work',
  ownership: 'external',
};

async function fakeClaude(directory: string): Promise<string> {
  const executable = join(directory, 'claude');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(process.env.FAKE_VERSION || '2.1.250 (Claude Code)');
  process.exit(0);
}
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args,
  configDir: process.env.CLAUDE_CONFIG_DIR || null,
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null
}) + '\\n');
if (process.env.FAKE_RETRY_FILE && !fs.existsSync(process.env.FAKE_RETRY_FILE)) {
  fs.writeFileSync(process.env.FAKE_RETRY_FILE, 'first');
  console.log(JSON.stringify({ is_error: false }));
  process.exit(0);
}
const respond = () => console.log(JSON.stringify({
  is_error: false,
  result: 'You are currently using your subscription to power your Claude Code usage\\n\\nCurrent session: 12% used · resets Sep 2 at 1:40am (UTC)\\nCurrent week (all models): 34% used · resets Sep 8 at 3am (UTC)\\n\\nLast 7d · 123 requests\\n  91% of your usage was at >200k context'
}));
if (process.env.FAKE_DELAY_MS) setTimeout(respond, Number(process.env.FAKE_DELAY_MS));
else respond();
`,
  );
  await chmod(executable, 0o700);
  return executable;
}

describe('Claude noninteractive live collection', () => {
  it('parses only named quota rows and keeps each reset with its own window', () => {
    const result = parseClaudeUsageText(
      `You are currently using your subscription to power your Claude Code usage

Current session: 12.5% used · resets Sep 2 at 1:40am (UTC)
Current week (all models): 34% used · resets Sep 8 at 3am (UTC)
Current week (Sonnet only): 7% used · resets Sep 8 at 3am (UTC)

What's contributing to your limits usage?
91% of your usage was at >200k context`,
      account,
      new Date('2026-09-01T19:00:00Z'),
    );
    expect(result).toMatchObject({ source: 'claude-cli', status: 'live' });
    expect(result.windows).toMatchObject([
      {
        id: 'five_hour',
        usedPercent: 12.5,
        resetAt: '2026-09-02T01:40:00.000Z',
        durationSeconds: 18_000,
      },
      {
        id: 'seven_day',
        usedPercent: 34,
        resetAt: '2026-09-08T03:00:00.000Z',
        durationSeconds: 604_800,
      },
      {
        id: 'seven_day_sonnet_only',
        usedPercent: 7,
        resetAt: '2026-09-08T03:00:00.000Z',
      },
    ]);
    expect(result.windows).toHaveLength(3);
  });

  it('parses relative, absolute, invalid-zone, reached, and extra-usage values', () => {
    const result = parseClaudeUsageText(
      `Current session: 100% used - resets in 47m, limit reached
Current week: 2% used - resets 2027-09-01T00:00:00Z
Extra usage balance remaining: $12.50`,
      account,
      new Date('2026-08-28T18:00:00Z'),
    );
    expect(result.windows).toMatchObject([
      { resetAt: '2026-08-28T18:47:00.000Z', reached: true },
      { resetAt: '2027-09-01T00:00:00.000Z' },
    ]);
    expect(result.credits).toEqual({ balance: '$12.50' });
    expect(
      parseClaudeUsageText('Current session: 1% used · resets 5am (Not/A_Zone)', account).windows[0]
        ?.resetAt,
    ).toBeNull();
    expect(
      parseClaudeUsageText('Current session: 1% used · resets 1787875200', account).windows[0]
        ?.resetAt,
    ).toBe(new Date(1_787_875_200 * 1_000).toISOString());
    expect(
      parseClaudeUsageText(
        'Current session: 1% used · resets 12pm (UTC)',
        account,
        new Date('2026-08-28T10:00:00Z'),
      ).windows[0]?.resetAt,
    ).toBe('2026-08-28T12:00:00.000Z');
    expect(
      parseClaudeUsageText(
        'Current session: 1% used · resets 12am (UTC)',
        account,
        new Date('2026-08-28T10:00:00Z'),
      ).windows[0]?.resetAt,
    ).toBe('2026-08-29T00:00:00.000Z');
  });

  it('rejects provider errors, unrelated percentages, and malformed envelopes', () => {
    expect(() => parseClaudeUsageText('Please log in to Claude Code', account)).toThrow(
      'logged out',
    );
    expect(() => parseClaudeUsageText('Failed to load usage data', account)).toThrow(
      'could not load',
    );
    expect(() => parseClaudeUsageText('Network error: unable to connect', account)).toThrow(
      'network error',
    );
    expect(() =>
      parseClaudeUsageText('Update available: new version is available', account),
    ).toThrow('upgrade notice');
    expect(() => parseClaudeUsageText('91% of your usage was at >200k context', account)).toThrow(
      'recognizable quota windows',
    );
    expect(() => parseClaudePrintResult({ stdout: '{', stderr: '', code: 0 }, account)).toThrow(
      'invalid noninteractive JSON',
    );
    expect(() =>
      parseClaudePrintResult(
        { stdout: JSON.stringify({ is_error: false }), stderr: '', code: 0 },
        account,
      ),
    ).toThrow('incomplete usage response');
    expect(() =>
      parseClaudePrintResult(
        { stdout: JSON.stringify({ is_error: true, result: 'failed' }), stderr: '', code: 0 },
        account,
      ),
    ).toThrow('incomplete usage response');
    expect(() =>
      parseClaudePrintResult({ stdout: '', stderr: 'unauthorized', code: 1 }, account),
    ).toThrow('logged out');
    expect(() =>
      parseClaudePrintResult({ stdout: '', stderr: 'unexpected failure', code: 5 }, account),
    ).toThrow('noninteractive usage check failed');
  });

  it('runs print mode for default and isolated accounts with scrubbed credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-print-'));
    const executable = await fakeClaude(directory);
    const log = join(directory, 'calls.jsonl');
    const priorLog = process.env.FAKE_LOG;
    const priorApiKey = process.env.ANTHROPIC_API_KEY;
    const priorOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.FAKE_LOG = log;
    process.env.ANTHROPIC_API_KEY = 'must-not-pass';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'must-not-pass';
    try {
      const tracker = new ProcessTracker();
      const adapter = new ClaudeLiveAdapter(executable, tracker);
      const defaultResult = await adapter.collect(
        { ...account, label: 'default', claudeDefault: true },
        { timeoutMs: 1_000 },
      );
      const isolatedResult = await adapter.collect(account, { timeoutMs: 1_000 });
      expect(defaultResult).toMatchObject({ source: 'claude-cli' });
      expect(defaultResult.windows[0]).toMatchObject({ id: 'five_hour' });
      expect(isolatedResult).toMatchObject({ source: 'claude-cli' });
      expect(isolatedResult.windows[0]).toMatchObject({ id: 'five_hour' });
      expect(tracker.size).toBe(0);
    } finally {
      if (priorLog === undefined) delete process.env.FAKE_LOG;
      else process.env.FAKE_LOG = priorLog;
      if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = priorApiKey;
      if (priorOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorOauth;
    }
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ configDir: null, apiKey: null, oauthToken: null });
    expect(calls[1]).toMatchObject({
      configDir: account.stateDir,
      apiKey: null,
      oauthToken: null,
    });
    expect(calls[0]?.args).toEqual([
      '-p',
      '/usage',
      '--tools',
      '',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--safe-mode',
    ]);
  });

  it('retries an incomplete response once and rejects unsupported versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-retry-'));
    const executable = await fakeClaude(directory);
    const retryFile = join(directory, 'retried');
    const priorRetry = process.env.FAKE_RETRY_FILE;
    process.env.FAKE_RETRY_FILE = retryFile;
    try {
      const messages: string[] = [];
      await expect(
        new ClaudeLiveAdapter(executable, new ProcessTracker()).collect(account, {
          timeoutMs: 1_000,
          verbose: (message) => messages.push(message),
        }),
      ).resolves.toMatchObject({ source: 'claude-cli' });
      expect(messages).toContain('claude:work: incomplete usage response; retrying once');
    } finally {
      if (priorRetry === undefined) delete process.env.FAKE_RETRY_FILE;
      else process.env.FAKE_RETRY_FILE = priorRetry;
    }

    const priorVersion = process.env.FAKE_VERSION;
    process.env.FAKE_VERSION = '2.1.237 (Claude Code)';
    try {
      await expect(
        new ClaudeLiveAdapter(executable, new ProcessTracker()).version(),
      ).rejects.toMatchObject({ data: { code: 'unsupported_vendor_version' } });
    } finally {
      if (priorVersion === undefined) delete process.env.FAKE_VERSION;
      else process.env.FAKE_VERSION = priorVersion;
    }
  });

  it('times out with account context and leaves no tracked child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-timeout-'));
    const executable = await fakeClaude(directory);
    const tracker = new ProcessTracker();
    const priorDelay = process.env.FAKE_DELAY_MS;
    process.env.FAKE_DELAY_MS = '1000';
    try {
      await expect(
        new ClaudeLiveAdapter(executable, tracker).collect(account, { timeoutMs: 20 }),
      ).rejects.toMatchObject({
        data: { code: 'timeout', provider: 'claude', accountLabel: 'work' },
      });
      expect(tracker.size).toBe(0);
    } finally {
      if (priorDelay === undefined) delete process.env.FAKE_DELAY_MS;
      else process.env.FAKE_DELAY_MS = priorDelay;
    }
  });
});
