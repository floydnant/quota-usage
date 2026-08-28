import { describe, expect, it } from 'vitest';
import { vendorEnvironment } from '../src/executable.js';

describe('vendor process environment isolation', () => {
  it('pins state directories and removes calling-shell credentials', () => {
    const base = {
      PATH: '/bin',
      CODEX_HOME: '/wrong-codex',
      CLAUDE_CONFIG_DIR: '/wrong-claude',
      OPENAI_API_KEY: 'secret',
      CODEX_ACCESS_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    };
    const codex = vendorEnvironment('codex', '/registered/codex', base);
    expect(codex).toMatchObject({ PATH: '/bin', CODEX_HOME: '/registered/codex' });
    expect(codex).not.toHaveProperty('OPENAI_API_KEY');
    expect(codex).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    const claude = vendorEnvironment('claude', '/registered/claude', base);
    expect(claude).toMatchObject({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/registered/claude' });
    expect(claude).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(claude).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claude).not.toHaveProperty('CODEX_HOME');

    const defaultClaude = vendorEnvironment('claude', '/registered/default', base, {
      claudeDefault: true,
    });
    expect(defaultClaude).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(defaultClaude).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
