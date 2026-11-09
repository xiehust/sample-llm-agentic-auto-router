// CDK app (Node 24 runs this file directly; types are stripped). Every deployment value is a deploy input:
//   npx cdk synth -c region=<aws-region> -c account=<account-id> [-c azIds=<id>,<id>] [-c prefix=<unique-prefix>]
//                 [-c tags='{"Owner":"<team>"}'] [-c policyFile=<path>] [-c catalogFile=<path>]
//                 [-c allowedModelUniverse=policy|catalog|<model-id>,...]
//                 [-c routerDesiredCount=0] [-c throttle=20,40]
//                 [-c console=true [-c adminEmail=<e-mail>] [-c consoleBundle=true] [-c ingest=true]]
// Bring the router up with -c routerDesiredCount=1 only after the anonymous-denial checks (E0) pass.
import { App, Tags, Validations } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { ConsoleStack, resolveConsoleSettings } from './console-stack.ts'
import { DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { stagePacksArchive } from './packs.ts'
import { resolveSettings } from './settings.ts'
import { RouterStack } from './stack.ts'

const app = new App()
const settings = resolveSettings(app.node, process.env, DEFAULT_POLICY_FILE)
const models = deployModels(settings)
// Packs archive for the console (-c packsArchive=off skips it): staged offline from the committed manifest.
const packsOff = ['off', 'false', '0'].includes(String(app.node.tryGetContext('packsArchive') ?? ''))
new RouterStack(app, `${settings.prefix}-router`, {
  env: { account: settings.account, region: settings.region }, settings, models, description: 'llm-auto-router data plane. Delete after use.',
  ...(packsOff ? {} : { packsArchiveDir: stagePacksArchive() }),
})
// Admin console (-c console=true): deployed after the router stack, destroyed before it; see console-stack.ts for the
// deploy order (-c consoleBundle / -c ingest / -c adminEmail).
if (['true', '1', 'on'].includes(String(app.node.tryGetContext('console') ?? ''))) {
  const consoleSettings = resolveConsoleSettings(app.node, process.env)
  new ConsoleStack(app, `${consoleSettings.prefix}-console`, {
    env: { account: consoleSettings.account, region: consoleSettings.region }, settings: consoleSettings, description: 'llm-auto-router admin console. Delete after use.',
  })
}
for (const [k, v] of Object.entries(settings.tags)) Tags.of(app).add(k, v)
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }))
app.synth()
