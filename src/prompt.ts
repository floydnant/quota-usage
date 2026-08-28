import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export type Confirm = (message: string) => Promise<boolean>;

export const confirm: Confirm = async (message) => {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
};
