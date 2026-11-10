import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertTrashUsable, moveToTrash } from '../src/trash.js';

const infoWrite = vi.hoisted(() => ({ fail: false }));
const devices = vi.hoisted(() => ({ split: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      if (devices.split && String(args[0]).endsWith('/files')) {
        return Object.assign(result, { dev: Number(result.dev) + 1 });
      }
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (infoWrite.fail) {
        handle.writeFile = async () => {
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        };
      }
      return handle;
    },
  };
});

async function directoryWithFile(parent: string, name: string): Promise<string> {
  const source = join(parent, name);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'kept.txt'), 'kept');
  return source;
}

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'trash-')));
}

function encoded(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

describe('moveToTrash with the freedesktop layout', () => {
  it('moves the directory into files/ and records it in info/', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');

    const trashed = await moveToTrash(
      source,
      'usage-codex-x-1',
      { dir, layout: 'freedesktop' },
      new Date(2026, 10, 10, 9, 5, 7),
    );

    expect(trashed).toBe(join(dir, 'files', 'usage-codex-x-1'));
    expect(await readFile(join(trashed, 'kept.txt'), 'utf8')).toBe('kept');
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dir, 'info', 'usage-codex-x-1.trashinfo'), 'utf8')).toBe(
      `[Trash Info]\nPath=${encoded(root)}/account\nDeletionDate=2026-11-10T09:05:07\n`,
    );
  });

  it('percent-encodes the original path but keeps its separators', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(join(root, 'with space'), 'ü%');
    const dir = join(root, 'Trash');

    await moveToTrash(source, 'name', { dir, layout: 'freedesktop' }, new Date(0));

    const info = await readFile(join(dir, 'info', 'name.trashinfo'), 'utf8');
    expect(info).toContain(`Path=${encoded(root)}/with%20space/%C3%BC%25\n`);
  });

  it('records the deletion date in local time', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      await moveToTrash(
        source,
        'name',
        { dir, layout: 'freedesktop' },
        new Date(Date.UTC(2026, 10, 10, 0, 5, 7)),
      );
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }

    const info = await readFile(join(dir, 'info', 'name.trashinfo'), 'utf8');
    expect(info).toContain('DeletionDate=2026-11-10T09:05:07\n');
  });

  it('leaves an existing trash and its entries untouched', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    await mkdir(join(dir, 'files', 'older'), { recursive: true });
    await mkdir(join(dir, 'info'), { recursive: true });
    await writeFile(join(dir, 'info', 'older.trashinfo'), 'older');
    await chmod(dir, 0o755);

    await moveToTrash(source, 'name', { dir, layout: 'freedesktop' }, new Date(0));

    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await readdir(join(dir, 'files'))).sort()).toEqual(['name', 'older']);
    expect(await readFile(join(dir, 'info', 'older.trashinfo'), 'utf8')).toBe('older');
  });

  it('creates the trash directories privately', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'share', 'Trash');

    await moveToTrash(source, 'name', { dir, layout: 'freedesktop' }, new Date(0));

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'files'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'info'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'info', 'name.trashinfo'))).mode & 0o777).toBe(0o600);
  });

  it('removes the info file and rethrows when the move fails', async () => {
    const root = await tempRoot();
    const dir = join(root, 'Trash');

    await expect(
      moveToTrash(join(root, 'missing'), 'name', { dir, layout: 'freedesktop' }, new Date(0)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await readdir(join(dir, 'info'))).toEqual([]);
  });

  it('removes the info file and keeps the source when writing it fails', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    infoWrite.fail = true;
    try {
      await expect(
        moveToTrash(source, 'name', { dir, layout: 'freedesktop' }, new Date(0)),
      ).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally {
      infoWrite.fail = false;
    }

    expect(await readdir(join(dir, 'info'))).toEqual([]);
    expect(await readFile(join(source, 'kept.txt'), 'utf8')).toBe('kept');
  });

  it('refuses to replace an orphan entry in files/', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    await mkdir(join(dir, 'files', 'name'), { recursive: true });

    await expect(
      moveToTrash(source, 'name', { dir, layout: 'freedesktop' }, new Date(0)),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(join(source, 'kept.txt'), 'utf8')).toBe('kept');
    expect(await readdir(join(dir, 'files', 'name'))).toEqual([]);
    expect(await readdir(join(dir, 'info'))).toEqual([]);
  });

  it('never overwrites an existing info file for the same name', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    await mkdir(join(dir, 'info'), { recursive: true });
    await writeFile(join(dir, 'info', 'name.trashinfo'), 'original');

    await expect(
      moveToTrash(source, 'name', { dir, layout: 'freedesktop' }, new Date(0)),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(join(dir, 'info', 'name.trashinfo'), 'utf8')).toBe('original');
    expect(await readFile(join(source, 'kept.txt'), 'utf8')).toBe('kept');
  });
});

describe('assertTrashUsable', () => {
  it('prepares the freedesktop directories without writing an entry', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');

    await assertTrashUsable(source, { dir, layout: 'freedesktop' });

    expect(await readdir(join(dir, 'files'))).toEqual([]);
    expect(await readdir(join(dir, 'info'))).toEqual([]);
  });

  it('rejects a file where the trash directory should be', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    await writeFile(dir, 'not a directory');

    await expect(assertTrashUsable(source, { dir, layout: 'freedesktop' })).rejects.toBeDefined();
  });

  it('rejects a trash on another filesystem', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    devices.split = true;
    try {
      await expect(assertTrashUsable(source, { dir, layout: 'freedesktop' })).rejects.toMatchObject(
        { code: 'EXDEV' },
      );
    } finally {
      devices.split = false;
    }
  });

  it.skipIf(process.getuid?.() === 0)('rejects a read-only info directory', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    await mkdir(join(dir, 'files'), { recursive: true });
    await mkdir(join(dir, 'info'), { recursive: true });
    await chmod(join(dir, 'info'), 0o500);

    await expect(assertTrashUsable(source, { dir, layout: 'freedesktop' })).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it.skipIf(process.getuid?.() === 0)('rejects a source whose parent is read-only', async () => {
    const root = await tempRoot();
    const parent = join(root, 'parent');
    const source = await directoryWithFile(parent, 'account');
    const dir = join(root, 'Trash');
    await chmod(parent, 0o500);
    try {
      await expect(assertTrashUsable(source, { dir, layout: 'freedesktop' })).rejects.toMatchObject(
        { code: 'EACCES' },
      );
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it.skipIf(process.getuid?.() === 0)('rejects a read-only source directory', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, 'Trash');
    await chmod(source, 0o500);
    try {
      await expect(assertTrashUsable(source, { dir, layout: 'freedesktop' })).rejects.toMatchObject(
        { code: 'EACCES' },
      );
    } finally {
      await chmod(source, 0o700);
    }
  });

  it('checks nothing for the flat layout', async () => {
    const root = await tempRoot();
    const dir = join(root, '.Trash');

    await assertTrashUsable(join(root, 'missing'), { dir, layout: 'flat' });

    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('moveToTrash with the flat layout', () => {
  it('moves the directory straight into the trash directory', async () => {
    const root = await tempRoot();
    const source = await directoryWithFile(root, 'account');
    const dir = join(root, '.Trash');

    const trashed = await moveToTrash(source, 'name', { dir, layout: 'flat' }, new Date(0));

    expect(trashed).toBe(join(dir, 'name'));
    expect(await readFile(join(trashed, 'kept.txt'), 'utf8')).toBe('kept');
    expect(await readdir(dir)).toEqual(['name']);
  });
});
