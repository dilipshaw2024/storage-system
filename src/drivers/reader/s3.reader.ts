/**
 * Source reader implementation for storage-core.
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import type { Readable } from 'stream'
import type { FileDescriptor, ReaderDriver } from '../../types'

function requireString(c: Record<string, any>, key: string, ctx: string): string {
  const v = c[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`S3 reader sourceCredentials.${key} is missing or empty (${ctx}).`)
  }
  return v
}

function requireInsuranceCompanyCode(c: Record<string, any>, ctx: string): string {
  const raw = c.insuranceCompanyCode ?? c.insurance_company_code
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`S3 reader sourceCredentials.insuranceCompanyCode is missing or empty (${ctx}).`)
  }
  return raw.trim()
}

function currentDayFolderNames(now = new Date()): string[] {
  const day = String(now.getDate()).padStart(2, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const year = String(now.getFullYear())
  return [`${day}-${month}-${year.slice(-2)}`, `${day}-${month}-${year}`]
}

function joinObjectPrefix(prefix: string, folder: string): string {
  if (!prefix) return `${folder}/`
  return `${prefix.replace(/\/+$/, '')}/${folder}/`
}

function fileDescriptorFromObjectKey(
  key: string,
  sourcePrefix: string,
  orgId: string,
  insuranceCompanyCode: string,
  size: number,
): FileDescriptor | null {
  const relativePath = sourcePrefix ? key.slice(sourcePrefix.length) : key
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const claimFolder = parts[parts.length - 2]
  const fileName = parts[parts.length - 1]
  if (!claimFolder || !fileName) return null
  const lower = fileName.toLowerCase()
  const mimeType = lower.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
  return {
    orgId,
    insuranceCompanyCode,
    claimFolder,
    fileName,
    filePath: key,
    fileSizeBytes: size,
    mimeType,
  }
}

function createS3Client(credentials: Record<string, any>, ctx: string): S3Client {
  const accessKey = requireString(credentials, 'access_key', ctx)
  const secretKey = requireString(credentials, 'secret_key', ctx)
  const region = requireString(credentials, 'region', ctx)
  const endpoint = credentials.endpoint
  const endpointStr = typeof endpoint === 'string' ? endpoint.trim() : ''

  return new S3Client({
    region,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    ...(endpointStr ? { endpoint: endpointStr } : {}),
  })
}

async function listObjectsRecursive(
  client: S3Client,
  bucket: string,
  prefix = '',
): Promise<Array<{ Key: string; Size: number }>> {
  const items: Array<{ Key: string; Size: number }> = []
  let continuationToken: string | undefined

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of response.Contents ?? []) {
      if (obj.Key) {
        items.push({ Key: obj.Key, Size: typeof obj.Size === 'number' ? obj.Size : 0 })
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  return items
}

export const s3ReaderDriver: ReaderDriver = {
  async listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]> {
    const bucket = requireString(credentials, 'bucket', `orgId ${orgId}`)
    const insuranceCompanyCode = requireInsuranceCompanyCode(credentials, `orgId ${orgId}`)
    const sourcePrefix =
      typeof credentials.source_prefix === 'string' ? credentials.source_prefix : ''
    const client = createS3Client(credentials, `orgId ${orgId}`)

    // S3 folders are virtual prefixes. Query only today's two supported
    // folder formats instead of scanning the complete bucket.
    const objectsByKey = new Map<string, { Key: string; Size: number }>()
    for (const folder of currentDayFolderNames()) {
      const datePrefix = joinObjectPrefix(sourcePrefix, folder)
      const objects = await listObjectsRecursive(client, bucket, datePrefix)
      for (const object of objects) objectsByKey.set(object.Key, object)
    }

    const out: FileDescriptor[] = []
    for (const obj of objectsByKey.values()) {
      if (obj.Key.endsWith('/')) continue
      if (sourcePrefix && !obj.Key.startsWith(sourcePrefix)) continue
      const fd = fileDescriptorFromObjectKey(
        obj.Key,
        sourcePrefix,
        orgId,
        insuranceCompanyCode,
        obj.Size,
      )
      if (fd) out.push(fd)
    }
    return out
  },

  async readFile(credentials: Record<string, any>, filePath: string): Promise<Readable> {
    const bucket = requireString(credentials, 'bucket', 'readFile')
    const client = createS3Client(credentials, 'readFile')

    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: filePath,
      }),
    )

    return response.Body as unknown as Readable
  },
}
