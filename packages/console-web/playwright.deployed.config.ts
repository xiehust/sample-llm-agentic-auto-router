import { defineConfig, devices } from '@playwright/test'

// The deployed-console check (e2e/deployed.spec.ts), separate from the local smoke. Run it with
//   pnpm --filter @auto-router/console-web e2e:deployed
// and the env described in the spec header. It starts no servers and makes no AWS API calls: it drives the
// deployed SPA and Cognito managed login in a browser, like a user.
//
// Credentials hygiene: traces, videos and failure screenshots are off (a trace records typed values), and the only
// reporter is `list`. Page screenshots are taken explicitly, after sign-in, into a gitignored directory.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: 'e2e',
  testMatch: /deployed\.spec\.ts$/,
  outputDir: 'e2e/deployed-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(process.env.CONSOLE_URL ? { baseURL: process.env.CONSOLE_URL } : {}),
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
})
