import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the Electron e2e suite.
 *
 * Only `tests/e2e/**` is a Playwright project — the SDK's unit/integration
 * specs run under vitest (which excludes tests/e2e). Electron launches one app
 * per test, so we run serially (`workers: 1`) and retry once to absorb hosted-
 * page latency (spec Error Handling), while a persistent failure stays a real
 * gate failure.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
});
