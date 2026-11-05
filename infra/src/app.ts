// CDK app (Node 24 runs this file directly; types are stripped). Every deployment value is a deploy input:
//   npx cdk synth -c region=<aws-region> -c account=<account-id> [-c azIds=<id>,<id>] [-c prefix=<unique-prefix>]
//                 [-c tags='{"Owner":"<team>"}'] [-c policyFile=<path>] [-c catalogFile=<path>]
//                 [-c routerDesiredCount=0] [-c throttle=20,40]
// Bring the router up with -c routerDesiredCount=1 only after the anonymous-denial checks (E0) pass.
import { App, Tags, Validations } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { resolveSettings } from './settings.ts'
import { RouterStack } from './stack.ts'

const app = new App()
const settings = resolveSettings(app.node, process.env, DEFAULT_POLICY_FILE)
const models = deployModels(settings)
new RouterStack(app, `${settings.prefix}-router`, {
  env: { account: settings.account, region: settings.region }, settings, models, description: 'llm-auto-router data plane. Delete after use.',
})
for (const [k, v] of Object.entries(settings.tags)) Tags.of(app).add(k, v)
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }))
app.synth()
