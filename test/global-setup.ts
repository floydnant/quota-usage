import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

// Tests create their fixtures with mkdtemp(tmpdir()) and never remove them.
// Point tmpdir() at one root per run (workers inherit the env) and delete it
// afterwards, so repeated runs do not pile up thousands of directories.
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'quota-usage-tests-'));
  const previous = TEMP_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_VARS) process.env[name] = root;

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`Could not remove test temp root ${root}:`, error);
    }
  };
}
