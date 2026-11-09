// CloudFormation custom resource (CDK Provider onEvent, a3's ConsoleStack): seeds the first admin, so the console is
// reachable after deploy (console authorization reads MEMBER#<kind:id>/PROFILE on every request). Create/Update:
// find the user by e-mail, else invite it; add it to the admin group; put MEMBER#user:<sub>/PROFILE
// {status: active, role: admin} only if absent (an existing member is never overwritten). Delete: no-op.
// Logs ids and codes only, never the e-mail.
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, CognitoIdentityProviderClient, ListUsersCommand, type UserType } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import type { Sender } from './aws/dynamo.ts'
import { toItem } from './aws/dynamo.ts'

export interface SeedEvent { RequestType: 'Create' | 'Update' | 'Delete'; ResourceProperties?: { email?: unknown; group?: unknown }; PhysicalResourceId?: string }
export interface SeedResult { PhysicalResourceId: string; Data?: { sub: string } }

const EMAIL = /^[^\s@"\\]{1,64}@[^\s@"\\]{1,190}\.[^\s@"\\]{2,63}$/
const PHYSICAL_ID = 'seed-admin'

export async function seedAdmin(e: SeedEvent, o: { idp: Sender; db: Sender; userPoolId: string; table: string; now?: () => number; log?: (x: Record<string, unknown>) => void }): Promise<SeedResult> {
  const log = o.log ?? ((x) => { process.stdout.write(`${JSON.stringify(x)}\n`) })
  if (e.RequestType === 'Delete') return { PhysicalResourceId: e.PhysicalResourceId ?? PHYSICAL_ID }
  const email = typeof e.ResourceProperties?.email === 'string' ? e.ResourceProperties.email.trim().toLowerCase() : ''
  if (!EMAIL.test(email)) throw new Error('seed-admin: ResourceProperties.email must be an e-mail address')
  if (e.ResourceProperties?.group !== undefined && e.ResourceProperties.group !== 'admin') throw new Error("seed-admin: group must be 'admin'")

  const found = await o.idp.send(new ListUsersCommand({ UserPoolId: o.userPoolId, Filter: `email = "${email}"`, Limit: 2 }))
  let user = ((found.Users ?? []) as UserType[])[0]
  let created = false
  if (!user) {
    const r = await o.idp.send(new AdminCreateUserCommand({
      UserPoolId: o.userPoolId, Username: email, DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
    }))
    user = r.User as UserType
    created = true
  }
  const sub = user?.Attributes?.find((a) => a.Name === 'sub')?.Value?.toLowerCase()
  if (!user?.Username || !sub) throw new Error('seed-admin: Cognito returned no user sub')
  await o.idp.send(new AdminAddUserToGroupCommand({ UserPoolId: o.userPoolId, Username: user.Username, GroupName: 'admin' }))

  const at = new Date((o.now ?? Date.now)()).toISOString()
  let wrote = true
  try {
    await o.db.send(new PutItemCommand({
      TableName: o.table, ConditionExpression: 'attribute_not_exists(pk)',
      Item: toItem({ pk: `MEMBER#user:${sub}`, sk: 'PROFILE', status: 'active', role: 'admin', budgetMonthlyUsd: null, createdAt: at, updatedAt: at }),
    }))
  } catch (err) {
    if (!(err instanceof Error && err.name === 'ConditionalCheckFailedException')) throw err
    wrote = false // an existing member keeps its role and status
  }
  log({ kind: 'seed-admin', principal: `user:${sub}`, created, memberWritten: wrote })
  return { PhysicalResourceId: PHYSICAL_ID, Data: { sub } }
}

export async function seedAdminHandler(e: SeedEvent): Promise<SeedResult> {
  const pool = process.env.USER_POOL_ID
  const table = process.env.CONSOLE_TABLE
  if (!pool || !table) throw new Error('seed-admin: USER_POOL_ID and CONSOLE_TABLE are required')
  const region = process.env.AWS_REGION
  return seedAdmin(e, { idp: new CognitoIdentityProviderClient(region ? { region } : {}), db: new DynamoDBClient(region ? { region } : {}), userPoolId: pool, table })
}
