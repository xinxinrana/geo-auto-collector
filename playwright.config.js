import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 12000 },
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results'
});
