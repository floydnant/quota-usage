import { describe, expect, it, vi } from 'vitest';
import { killWindowsTree } from '../src/platform.js';

// Node throws synchronously from spawn() for some failures instead of emitting
// 'error'. A tree kill sits on cleanup paths, so it must still settle.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error('spawn failed synchronously');
    }),
  };
});

describe('killWindowsTree', () => {
  it('resolves instead of rejecting when taskkill cannot be spawned', async () => {
    await expect(killWindowsTree(123_456, 50)).resolves.toBeUndefined();
  });
});
