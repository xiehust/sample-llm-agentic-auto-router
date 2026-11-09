import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import { securityHeaders } from './scripts/security-headers.ts'

// Local servers bind 127.0.0.1 only (never --host). /api goes to CONSOLE_API_TARGET: the mock API by default, or a
// deployed API (the same-origin path CloudFront serves in production, design 0.7). With CONSOLE_MOCK=1 the mock
// also serves /config.json, pointing the SPA at its fake IdP; otherwise /config.json comes from public/ (dev) or is
// absent (preview), as on S3 where the deploy writes it.
const apiTarget = process.env.CONSOLE_API_TARGET ?? 'http://127.0.0.1:4310'
const mock = process.env.CONSOLE_MOCK === '1'
const cognitoOrigin = process.env.CONSOLE_COGNITO_ORIGIN ?? 'http://127.0.0.1:4311'

const proxy: Record<string, ProxyOptions> = {
  '/api': { target: apiTarget, changeOrigin: true },
  ...(mock ? { '/config.json': { target: apiTarget, changeOrigin: true } } : {}),
}

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy, headers: securityHeaders({ cognitoOrigin }) },
  build: { target: 'es2023', sourcemap: false, chunkSizeWarningLimit: 1200 },
})
