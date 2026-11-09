// Writes the Run Command scripts that switch a running runner's container egress (runnerEgressSwitchScript) to
// runner-ssm/, for the default proxy port: `node src/runner-ssm.ts` from infra/. runner.test.ts fails if the
// committed files differ from what this generates.
import { writeFileSync } from 'node:fs'
import { DEFAULT_RUNNER_PROXY_PORT, RUNNER_CONTAINER_EGRESS, runnerEgressSwitchScript } from './runner.ts'

export const runnerSsmFiles = (): Record<string, string> => Object.fromEntries(RUNNER_CONTAINER_EGRESS.map((m) =>
  [`runner-egress-${m}.sh`, `${runnerEgressSwitchScript(m, DEFAULT_RUNNER_PROXY_PORT).join('\n')}\n`]))

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../runner-ssm/', import.meta.url)
  for (const [name, body] of Object.entries(runnerSsmFiles())) writeFileSync(new URL(name, dir), body, { mode: 0o755 })
}
