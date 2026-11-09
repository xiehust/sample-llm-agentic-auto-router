// `pnpm dev:mock`: the mock API + fake IdP and the Vite dev server together, all on 127.0.0.1.

import { spawn } from 'node:child_process'
import { startMock } from '../mock/server.ts'

const stack = await startMock()
console.log(`mock API ${stack.apiUrl}, fake IdP ${stack.idpUrl}`)
const vite = spawn('pnpm', ['exec', 'vite'], {
  stdio: 'inherit',
  env: { ...process.env, CONSOLE_MOCK: '1', CONSOLE_API_TARGET: stack.apiUrl, CONSOLE_COGNITO_ORIGIN: stack.idpUrl },
})
const stop = () => { vite.kill('SIGTERM'); void stack.close().then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
vite.on('exit', (code) => { void stack.close().then(() => process.exit(code ?? 0)) })
