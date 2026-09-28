import { chmod, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Writes a fake vendor CLI implemented as a Node script and returns the path to
 * spawn. Windows cannot run a shebang file, so it also gets a `.cmd` shim, the
 * same shape npm installs for the real vendor CLIs.
 */
export async function writeFakeExecutable(path: string, source: string): Promise<string> {
  await writeFile(path, source);
  if (process.platform !== 'win32') {
    await chmod(path, 0o700);
    return path;
  }
  await writeFile(`${path}.cmd`, `@"${process.execPath}" "%~dp0${basename(path)}" %*\r\n`);
  return `${path}.cmd`;
}
