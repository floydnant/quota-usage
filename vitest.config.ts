import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      include: [
        'src/config.ts',
        'src/selectors.ts',
        'src/cache.ts',
        'src/processes.ts',
        'src/providers/**/*.ts',
      ],
      thresholds: { branches: 80 },
    },
  },
});
