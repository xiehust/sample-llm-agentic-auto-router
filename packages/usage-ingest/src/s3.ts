// identity/budget-blocks.json on the config bucket: ingest's only S3 object (a3 §3). Conditional writes keep two
// concurrent ingest invocations from overwriting each other's evaluation.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Sender } from './dynamo.ts'
import type { BlocksStore, BudgetBlocksDoc } from './types.ts'

const MAX_BYTES = 1024 * 1024

export class S3BlocksStore implements BlocksStore {
  private readonly s3: Sender
  private readonly bucket: string
  private readonly key: string
  constructor(s3: Sender, bucket: string, key = 'identity/budget-blocks.json') {
    this.s3 = s3
    this.bucket = bucket
    this.key = key
  }

  async read(): Promise<{ doc: BudgetBlocksDoc; etag: string } | undefined> {
    try {
      const res = (await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }))) as {
        Body?: { transformToString(): Promise<string> }
        ETag?: string
        ContentLength?: number
      }
      if ((res.ContentLength ?? 0) > MAX_BYTES) throw new Error('budget-blocks.json is too large')
      const text = (await res.Body?.transformToString()) ?? ''
      const doc = JSON.parse(text) as BudgetBlocksDoc
      if (doc?.schemaVersion !== 1 || !Array.isArray(doc.principals) || !res.ETag) throw new Error('budget-blocks.json is malformed')
      return { doc, etag: res.ETag }
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return undefined
      throw e
    }
  }

  async write(doc: BudgetBlocksDoc, etag: string | undefined): Promise<'ok' | 'conflict'> {
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket, Key: this.key, Body: `${JSON.stringify(doc)}\n`, ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }))
      return 'ok'
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
      const code = err.$metadata?.httpStatusCode
      if (err.name === 'PreconditionFailed' || err.name === 'ConditionalRequestConflict' || code === 412 || code === 409) return 'conflict'
      throw e
    }
  }
}
