// CDK app for the experiment runner (independent of the router app in app.ts). Every deployment value is a deploy input:
//   npx cdk deploy --app 'node src/runner-app.ts' -c region=<aws-region> -c account=<account-id> \
//     -c runnerSecretArn=<full secret ARN> [-c prefix=<unique-prefix>] [-c tags='{"Owner":"<team>"}'] \
//     [-c runnerAzId=<az-id>] [-c runnerInstanceType=m7i.2xlarge] [-c runnerAmiId=<ami-id>]
import { App, Tags, Validations } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { resolveRunnerSettings, RunnerStack } from './runner.ts'

const app = new App()
const settings = resolveRunnerSettings(app.node, process.env)
new RunnerStack(app, `${settings.prefix}-runner`, {
  env: { account: settings.account, region: settings.region }, settings,
  description: 'llm-auto-router experiment runner (x86 EC2, SSM only). Delete after the experiment.',
})
for (const [k, v] of Object.entries(settings.tags)) Tags.of(app).add(k, v)
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }))
app.synth()
