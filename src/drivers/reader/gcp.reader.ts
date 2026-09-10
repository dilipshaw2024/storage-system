/**
 * Source reader implementation for storage-core.
 */
import { Storage } from '@google-cloud/storage'
import type { Readable } from 'stream'
import type { FileDescriptor, ReaderDriver } from '../../types'

function requireString(c: Record<string, any>, key: string, ctx: string): string {
  const v = c[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`GCP reader sourceCredentials.${key} is missing or empty (${ctx}).`)
  }
  return v
}

function requireInsuranceCompanyCode(c: Record<string, any>, ctx: string): string {
  const raw = c.insuranceCompanyCode ?? c.insurance_company_code
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `GCP reader sourceCredentials.insuranceCompanyCode is missing or empty (${ctx}).`,
    )
  }
  return raw.trim()
}

function requireCredentialsObject(c: Record<string, any>, ctx: string): Record<string, any> {
  let raw = c.google_application_credentials
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new Error(
        `GCP reader sourceCredentials.google_application_credentials is invalid JSON (${ctx}).`,
      )
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `GCP reader sourceCredentials.google_application_credentials must be a non-null object (${ctx}).`,
    )
  }
  if (typeof raw.client_email !== 'string' || raw.client_email.trim() === '') {
    throw new Error(
      `GCP reader sourceCredentials.google_application_credentials.client_email is missing or empty (${ctx}).`,
    )
  }
  if (typeof raw.private_key !== 'string' || raw.private_key.trim() === '') {
    throw new Error(
      `GCP reader sourceCredentials.google_application_credentials.private_key is missing or empty (${ctx}).`,
    )
  }
  return raw
}

function parseFileSize(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function fileDescriptorFromObjectName(
  name: string,
  sourcePrefix: string,
  orgId: string,
  insuranceCompanyCode: string,
  size: number,
): FileDescriptor | null {
  const relativePath = sourcePrefix ? name.slice(sourcePrefix.length) : name
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
    filePath: name,
    fileSizeBytes: size,
    mimeType,
  }
}

function createGcsClient(credentials: Record<string, any>, ctx: string): Storage {
  const projectId = requireString(credentials, 'project_id', ctx)
  const serviceAccount = requireCredentialsObject(credentials, ctx)
  return new Storage({
    projectId,
    credentials: serviceAccount,
  })
}

async function listGcsObjects(
  storage: Storage,
  bucketName: string,
): Promise<Array<{ name: string; size: number }>> {
  const bucket = storage.bucket(bucketName)
  const items: Array<{ name: string; size: number }> = []
  let query: { autoPaginate: false; pageToken?: string } = { autoPaginate: false }

  while (true) {
    const [files, nextQuery] = await bucket.getFiles(query)
    for (const file of files) {
      if (file.name) {
        items.push({
          name: file.name,
          size: parseFileSize(file.metadata?.size),
        })
      }
    }
    const pageToken =
      typeof nextQuery?.pageToken === 'string' && nextQuery.pageToken.trim() !== ''
        ? nextQuery.pageToken
        : undefined
    if (!pageToken) break
    query = { autoPaginate: false, pageToken }
  }

  return items
}

export const gcpReaderDriver: ReaderDriver = {
  async listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]> {
    const bucketName = requireString(credentials, 'bucket_name', `orgId ${orgId}`)
    requireString(credentials, 'project_id', `orgId ${orgId}`)
    requireCredentialsObject(credentials, `orgId ${orgId}`)
    const insuranceCompanyCode = requireInsuranceCompanyCode(credentials, `orgId ${orgId}`)
    const sourcePrefix =
      typeof credentials.source_prefix === 'string' ? credentials.source_prefix : ''
    const storage = createGcsClient(credentials, `orgId ${orgId}`)

    const objects = await listGcsObjects(storage, bucketName)
    const out: FileDescriptor[] = []
    for (const obj of objects) {
      if (obj.name.endsWith('/')) continue
      if (sourcePrefix && !obj.name.startsWith(sourcePrefix)) continue
      const fd = fileDescriptorFromObjectName(
        obj.name,
        sourcePrefix,
        orgId,
        insuranceCompanyCode,
        obj.size,
      )
      if (fd) out.push(fd)
    }
    return out
  },

  async readFile(credentials: Record<string, any>, filePath: string): Promise<Readable> {
    const bucketName = requireString(credentials, 'bucket_name', 'readFile')
    requireString(credentials, 'project_id', 'readFile')
    requireCredentialsObject(credentials, 'readFile')
    const storage = createGcsClient(credentials, 'readFile')
    const bucket = storage.bucket(bucketName)

    return bucket.file(filePath).createReadStream()
  },
}
