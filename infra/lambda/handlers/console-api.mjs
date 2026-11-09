// Lambda entry shim: the runtime loads .mjs handlers; the implementation is TypeScript (Node 24 type stripping).
export { handler } from '../packages/console-api/src/lambda.ts'
