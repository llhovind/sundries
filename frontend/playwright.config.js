import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: 'list',

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start backend (port 3000) and Vite dev server (port 5173) before tests.
  // Both are assumed to NOT already be running when `npx playwright test` is invoked.
  webServer: [
    {
      command: 'node ../backend/bin/www',
      url: 'http://localhost:3000/',
      reuseExistingServer: true,
      timeout: 10_000,
      cwd: '../backend',
      // noop mail: e2e runs must never email real inboxes. Only effective
      // when Playwright boots the backend itself — a reused dev server
      // (reuseExistingServer) keeps whatever mail provider it started with.
      env: { NODE_ENV: 'test', MAIL_PROVIDER: 'noop' },
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173/',
      reuseExistingServer: true,
      timeout: 15_000,
    },
  ],
});
