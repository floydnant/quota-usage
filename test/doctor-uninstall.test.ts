import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js';
import { doctor, renderDoctor } from '../src/doctor.js';
import { appPaths } from '../src/paths.js';
import { uninstall, uninstallPreview } from '../src/uninstall.js';

describe('doctor and uninstall', () => {
  it('reports schema, permissions, executable versions, app-server, and PTY checks without quota calls', async () => {
    const home = await mkdtemp(join(tmpdir(), 'doctor-'));
    const store = new ConfigStore(appPaths(home));
    const bin = join(home, 'bin');
    await mkdir(bin);
    const codex = join(bin, 'codex');
    const claude = join(bin, 'claude');
    await writeFile(
      codex,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.150.1'; else echo '--stdio'; fi\n`,
    );
    await writeFile(claude, `#!/bin/sh\necho '2.1.238 (Claude Code)'\n`);
    await chmod(codex, 0o700);
    await chmod(claude, 0o700);
    await store.write(
      {
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, codexExecutable: codex, claudeExecutable: claude },
      },
      false,
    );
    const checks = await doctor(store);
    const output = renderDoctor(checks);
    expect(output).toContain('valid schema version 1');
    expect(output).toContain('Codex app-server capability');
    expect(output).toContain('Claude live PTY');
  });

  it('previews and removes helpers/caches while keeping vendor state and optionally config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'uninstall-'));
    const store = new ConfigStore(appPaths(home));
    const stateDir = join(home, 'vendor-state');
    await mkdir(stateDir);
    await writeFile(join(stateDir, 'keep'), 'vendor');
    await store.write(
      {
        ...DEFAULT_CONFIG,
        accounts: [
          { provider: 'codex', label: 'x', stateDir, ownership: 'managed', ownershipMarker: 'm' },
        ],
      },
      false,
    );
    await mkdir(store.paths.binDir, { recursive: true });
    await mkdir(store.paths.cacheDir, { recursive: true });
    await writeFile(join(store.paths.binDir, 'helper'), 'x');
    await writeFile(join(store.paths.cacheDir, 'codex-x.json'), '{}');
    expect((await uninstallPreview(store)).join(' ')).toContain('Leave every vendor state');
    let prompts = 0;
    const messages = await uninstall(store, async () => ++prompts === 1);
    expect(messages.join(' ')).toContain('Kept usage configuration');
    expect(await readFile(join(stateDir, 'keep'), 'utf8')).toBe('vendor');
    expect(await store.load()).toMatchObject({ schemaVersion: 1 });
  });
});
