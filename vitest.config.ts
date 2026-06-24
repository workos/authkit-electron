import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'tests/**/*.spec.ts'],
    // The Playwright + Electron e2e specs (tests/e2e/*.spec.ts) run via
    // `pnpm test:e2e` (playwright.config.ts), never under vitest — its runner
    // can't launch Electron. Exclude them and the example workspace so
    // `vitest run` only collects the SDK's unit/integration specs.
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**', 'example/**'],
    // Node by default (fast; main/preload tests). React renderer tests opt into
    // jsdom per-file via a `@vitest-environment jsdom` docblock.
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'coverage/',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.test.ts',
        '**/*.test.tsx',
        'vitest.config.ts',
      ],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
