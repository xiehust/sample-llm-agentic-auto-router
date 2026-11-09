// Lambda entry (CloudWatch Logs subscription, asynchronous invoke; a3 §3). Clients and caches live per container.
// Logs one JSON line per invocation with counts only: never a log line, id, token or cost value.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { loadCatalog } from '@auto-router/pricing'
import { DynamoBudgetSource, DynamoPolicySource, DynamoUsageStore } from './dynamo.ts'
import { ingest, type IngestDeps } from './ingest.ts'
import { decodePayload } from './parse.ts'
import { S3BlocksStore } from './s3.ts'

export interface IngestEnv {
  USAGE_TABLE?: string
  CONSOLE_TABLE?: string
  CONFIG_BUCKET?: string
  CATALOG_REGION?: string
  AWS_REGION?: string
  RECORD_RETENTION_DAYS?: string
  BUDGETS?: string
}

/** Validates the environment and builds the dependencies; throws on a misconfiguration (fail fast at cold start). */
export function depsFromEnv(env: IngestEnv, clients: { ddb: DynamoDBClient; s3: S3Client }): IngestDeps {
  const need = (k: keyof IngestEnv): string => {
    const v = env[k]
    if (!v) throw new Error(`usage-ingest: ${k} is required`)
    return v
  }
  const retention = Number(env.RECORD_RETENTION_DAYS ?? '90')
  if (!Number.isInteger(retention) || retention < 1 || retention > 3650) throw new Error('usage-ingest: RECORD_RETENTION_DAYS must be 1..3650')
  const budgets = (env.BUDGETS ?? 'off') === 'on'
  const consoleTable = need('CONSOLE_TABLE')
  return {
    catalog: loadCatalog(env.CATALOG_REGION ?? need('AWS_REGION')),
    policies: new DynamoPolicySource(clients.ddb, consoleTable),
    store: new DynamoUsageStore(clients.ddb, need('USAGE_TABLE')),
    retentionDays: retention,
    now: Date.now,
    ...(budgets ? { budgets: { source: new DynamoBudgetSource(clients.ddb, consoleTable), blocks: new S3BlocksStore(clients.s3, need('CONFIG_BUCKET')) } } : {}),
  }
}

let deps: IngestDeps | undefined

export async function handler(event: unknown): Promise<void> {
  deps ??= depsFromEnv(process.env as IngestEnv, { ddb: new DynamoDBClient({}), s3: new S3Client({}) })
  const report = await ingest(decodePayload(event), deps)
  process.stdout.write(`${JSON.stringify({ kind: 'ingest', ...report })}\n`)
}
