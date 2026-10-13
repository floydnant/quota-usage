import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';

/**
 * Writes a Node script that starts a stubborn grandchild, records
 * `[own pid, grandchild pid]` in the file named by its first argument, and then
 * idles. The grandchild does not share the parent's stdio, so the parent's exit
 * or close events say nothing about whether the grandchild is gone.
 */
export async function writeTreeScript(dir: string): Promise<string> {
  const script = join(dir, 'tree.js');
  await writeFile(
    script,
    `const { spawn } = require('node:child_process');
const fs = require('node:fs');
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`,
  );
  return script;
}

export async function readPids(file: string): Promise<number[]> {
  return JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as number[];
}

export async function waitForPids(file: string): Promise<number[]> {
  let pids: number[] = [];
  await expect
    .poll(
      async () => {
        pids = await readPids(file);
        return pids.length;
      },
      { timeout: 10_000, interval: 50 },
    )
    .toBe(2);
  return pids;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ends any test-spawned process that survived, so a failing test leaves no orphan. */
export async function killSurvivors(file: string, known: number[] = []): Promise<void> {
  for (const pid of new Set([...known, ...(await readPids(file))])) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already gone. */
    }
  }
}
