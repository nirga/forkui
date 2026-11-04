import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/e2e/**/*.e2e.test.ts'], testTimeout: 60 * 60_000, hookTimeout: 60_000 },
});
