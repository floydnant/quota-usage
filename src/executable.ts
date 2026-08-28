import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { UsageError } from './errors.js';
import type { Provider } from './types.js';

export async function resolveExecutable(
  name: string,
  configured: string | undefined,
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = configured
    ? [configured]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, name));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new UsageError('missing_vendor_executable', `${name} executable was not found`, {
    provider,
  });
}

export function parseVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1];
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function vendorEnvironment(
  provider: Provider,
  stateDir: string,
  base: NodeJS.ProcessEnv = process.env,
  options: { claudeDefault?: boolean | undefined } = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  if (provider === 'codex') {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
    env.CODEX_HOME = stateDir;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!options.claudeDefault) env.CLAUDE_CONFIG_DIR = stateDir;
  }
  return env;
}
