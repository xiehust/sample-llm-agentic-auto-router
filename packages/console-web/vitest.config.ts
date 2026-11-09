import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Component tests run in jsdom; the mock API and script tests opt into node with a `// @vitest-environment node`
// pragma. Playwright specs (e2e/) are not vitest tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    testTimeout: 20_000,
  },
})
