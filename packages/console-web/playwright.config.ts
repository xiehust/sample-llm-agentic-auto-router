import { defineConfig, devices } from '@playwright/test'

// Smoke test of the production bundle (vite preview with the production security headers) against the mock API and
// fake IdP. Everything binds 127.0.0.1. Browsers: `pnpm exec playwright install chromium`, or point
// PLAYWRIGHT_CHROMIUM_EXECUTABLE at an installed Chromium. Run `pnpm build` first (`pnpm e2e` does).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: 'e2e',
  // The deployed-console check has its own config (playwright.deployed.config.ts) and never runs here.
  testIgnore: /deployed\.spec\.ts$/,
  outputDir: 'e2e/results',
  timeout: 60_000,
  // Lazy page chunks load slowly when the shared build host is busy (load > 100): 5 s was flaky there.
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: [
    {
      command: 'node mock/server.ts',
      url: 'http://127.0.0.1:4310/config.json',
      env: { MOCK_APP_ORIGINS: 'http://127.0.0.1:4173', MOCK_API_PORT: '4310', MOCK_IDP_PORT: '4311' },
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'pnpm exec vite preview',
      url: 'http://127.0.0.1:4173/',
      env: { CONSOLE_MOCK: '1', CONSOLE_API_TARGET: 'http://127.0.0.1:4310', CONSOLE_COGNITO_ORIGIN: 'http://127.0.0.1:4311' },
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
})
