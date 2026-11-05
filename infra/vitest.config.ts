import { defineConfig } from 'vitest/config'

// cdk.out holds Docker asset contexts (a copy of the workspace, including other packages' tests): never collect them.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['cdk.out/**', 'node_modules/**'] } })
