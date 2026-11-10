import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appPaths } from '../src/paths.js';

const home = '/home/someone';

describe('appPaths on Linux', () => {
  it('uses the XDG default directories when the variables are unset', () => {
    const paths = appPaths(home, 'linux', {});
    expect(paths.configFile).toBe(join(home, '.config', 'usage', 'config.yaml'));
    expect(paths.dataDir).toBe(join(home, '.local', 'share', 'usage'));
    expect(paths.cacheDir).toBe(join(home, '.cache', 'usage'));
    expect(paths.trashDir).toBe(join(home, '.local', 'share', 'Trash'));
    expect(paths.trashLayout).toBe('freedesktop');
  });

  it('honours absolute XDG base directories', () => {
    const paths = appPaths(home, 'linux', {
      XDG_CONFIG_HOME: '/xdg/config',
      XDG_DATA_HOME: '/xdg/data',
      XDG_CACHE_HOME: '/xdg/cache',
    });
    expect(paths.configFile).toBe('/xdg/config/usage/config.yaml');
    expect(paths.backupFile).toBe('/xdg/config/usage/config.yaml.bak');
    expect(paths.managedRoot).toBe('/xdg/data/usage/accounts');
    expect(paths.binDir).toBe('/xdg/data/usage/bin');
    expect(paths.cacheDir).toBe('/xdg/cache/usage');
    expect(paths.trashDir).toBe('/xdg/data/Trash');
  });

  it('ignores empty and relative XDG values, as the XDG specification requires', () => {
    const paths = appPaths(home, 'linux', {
      XDG_CONFIG_HOME: '',
      XDG_DATA_HOME: 'relative/data',
      XDG_CACHE_HOME: './cache',
    });
    expect(paths.configDir).toBe(join(home, '.config', 'usage'));
    expect(paths.dataDir).toBe(join(home, '.local', 'share', 'usage'));
    expect(paths.cacheDir).toBe(join(home, '.cache', 'usage'));
  });

  it('keeps an explicit home self-contained when no environment is passed', () => {
    const ambient = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/ambient/config';
    try {
      expect(appPaths(home, 'linux').configDir).toBe(join(home, '.config', 'usage'));
    } finally {
      if (ambient === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = ambient;
    }
  });
});

describe('appPaths defaults', () => {
  it('reads the ambient XDG variables when no home is passed', () => {
    const ambient = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/ambient/data';
    try {
      expect(appPaths(undefined, 'linux').dataDir).toBe('/ambient/data/usage');
    } finally {
      if (ambient === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = ambient;
    }
  });

  it('follows the host platform', () => {
    const explicit = appPaths(home, process.platform, {});
    expect(appPaths(home).cacheDir).toBe(explicit.cacheDir);
    expect(appPaths(home).trashLayout).toBe(explicit.trashLayout);
  });
});

describe('appPaths on macOS', () => {
  it('keeps the existing locations and ignores XDG variables', () => {
    const paths = appPaths(home, 'darwin', {
      XDG_CONFIG_HOME: '/xdg/config',
      XDG_DATA_HOME: '/xdg/data',
      XDG_CACHE_HOME: '/xdg/cache',
    });
    expect(paths.configDir).toBe(join(home, '.config', 'usage'));
    expect(paths.dataDir).toBe(join(home, '.local', 'share', 'usage'));
    expect(paths.cacheDir).toBe(join(home, 'Library', 'Caches', 'usage'));
    expect(paths.trashDir).toBe(join(home, '.Trash'));
    expect(paths.trashLayout).toBe('flat');
  });
});
