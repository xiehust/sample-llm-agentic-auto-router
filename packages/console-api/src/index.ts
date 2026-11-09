// @auto-router/console-api: Lambda handlers for the admin console API (design v1 §2.4), routed by
// @auto-router/console-contract's ROUTES. The AWS adapters are injected (ports.ts); tests and local development use
// memory.ts.
export { createHandler, findRoute, HANDLERS, type Ctx, type Handler, type HandlerId } from './app.ts'
export { authorize, callerOf, parseGroups, type Caller, type MemberLookup } from './auth.ts'
export { capIssues, changedSections, pointer, validateConfigDocument, versionNumber, versionString, type DocContext, type DocResult } from './config-doc.ts'
export { HttpError, MAX_BODY_BYTES, type HttpApiEvent, type HttpApiResult } from './http.ts'
export * from './local-types.ts'
export * from './memory.ts'
export type * from './ports.ts'
export { detailOf, recordFilter, sessionOf, statusClass, summaryOf } from './records.ts'
export { BASELINE_TAG, savingsReport, usageReport, usageRow } from './report.ts'
export { activeVersion, deliver, routerState, versionKey } from './routes/config.ts'
export { BLOCKS_KEY, blocksDocument, PRINCIPALS_KEY, principalsDocument, publishIdentity } from './routes/members.ts'
export { packKey, runningPacks } from './routes/packs.ts'
export { decodeCursor, DynamoConsoleStore, DynamoUsageStore, encodeCursor, fromItem, toItem, type Sender } from './aws/dynamo.ts'
export { AgentCoreGateway, CloudWatchHealth, CognitoClientDirectory, CognitoDirectory, EcsRouterTasks, S3ObjectStore } from './aws/services.ts'
export { awsClients, depsFromEnv, EnvError, handler, type AwsClients } from './lambda.ts'
export { seedAdmin, seedAdminHandler, type SeedEvent, type SeedResult } from './seed.ts'
