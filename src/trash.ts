import { constants } from 'node:fs';
import { access, lstat, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensurePrivateDir, type TrashLayout } from './paths.js';

export interface TrashLocation {
  dir: string;
  layout: TrashLayout;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function deletionDate(now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function trashInfo(source: string, now: Date): string {
  const path = source.split('/').map(encodeURIComponent).join('/');
  return `[Trash Info]\nPath=${path}\nDeletionDate=${deletionDate(now)}\n`;
}

/**
 * Checks what a freedesktop move of `source` needs, so a purge can stop before its
 * irreversible logout: writable trash directories, a writable source and parent, and
 * one filesystem. Later failures, such as a full disk, remain possible. Writes no entry.
 */
export async function assertTrashUsable(source: string, trash: TrashLocation): Promise<void> {
  if (trash.layout === 'flat') return;
  const filesDir = join(trash.dir, 'files');
  const infoDir = join(trash.dir, 'info');
  await ensurePrivateDir(filesDir);
  await ensurePrivateDir(infoDir);
  await access(filesDir, constants.W_OK | constants.X_OK);
  await access(infoDir, constants.W_OK | constants.X_OK);
  await access(source, constants.W_OK | constants.X_OK);
  await access(dirname(source), constants.W_OK | constants.X_OK);
  if ((await stat(source)).dev !== (await stat(filesDir)).dev) {
    throw Object.assign(new Error(`${filesDir} is on another filesystem than ${source}`), {
      code: 'EXDEV',
    });
  }
}

/**
 * Moves `source` into the trash under `name` and returns its new path.
 *
 * The freedesktop layout requires the info file to exist before the move and
 * to be created exclusively, so a name is reserved atomically.
 */
export async function moveToTrash(
  source: string,
  name: string,
  trash: TrashLocation,
  now = new Date(),
): Promise<string> {
  if (trash.layout === 'flat') {
    await ensurePrivateDir(trash.dir);
    const target = join(trash.dir, name);
    await rename(source, target);
    return target;
  }
  const filesDir = join(trash.dir, 'files');
  const infoDir = join(trash.dir, 'info');
  await ensurePrivateDir(filesDir);
  await ensurePrivateDir(infoDir);
  const info = join(infoDir, `${name}.trashinfo`);
  const handle = await open(info, 'wx', 0o600);
  const target = join(filesDir, name);
  try {
    try {
      await handle.writeFile(trashInfo(source, now));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const occupied = await lstat(target).then(
      () => true,
      () => false,
    );
    if (occupied) {
      throw Object.assign(new Error(`Trash entry already exists: ${target}`), { code: 'EEXIST' });
    }
    await rename(source, target);
  } catch (error) {
    await unlink(info).catch(() => undefined);
    throw error;
  }
  return target;
}
