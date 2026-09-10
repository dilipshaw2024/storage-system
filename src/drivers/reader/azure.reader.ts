/**
 * Source reader implementation for storage-core.
 */
import {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob'
import type { Readable } from 'stream'
import type { FileDescriptor, ReaderDriver } from '../../types'

function requireString(c: Record<string, any>, key: string, ctx: string): string {
  const v = c[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Azure reader sourceCredentials.${key} is missing or empty (${ctx}).`)
  }
  return v
}

function requireInsuranceCompanyCode(c: Record<string, any>, ctx: string): string {
  const raw = c.insuranceCompanyCode ?? c.insurance_company_code
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `Azure reader sourceCredentials.insuranceCompanyCode is missing or empty (${ctx}).`,
    )
  }
  return raw.trim()
}

/**
 * Returns the date-folder names accepted by the FTP reader.
 * Both formats are supported because existing integrations use either a
 * two-digit or four-digit year in their source directory structure.
 */
function currentDayFolderNames(now = new Date()): Set<string> {
  const day = String(now.getDate()).padStart(2, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const year = String(now.getFullYear())
  return new Set([`${day}-${month}-${year.slice(-2)}`, `${day}-${month}-${year}`])
}

/**
 * Normalizes an Azure blob prefix for consistent comparisons with blob names.
 */
function normalizeBlobPath(path: string): string {
  return path.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Checks whether a blob is located below today's source folder.
 */
function isInCurrentDayFolder(
  blobName: string,
  sourcePrefix: string,
  currentDayFolders: Set<string>,
): boolean {
  const normalizedBlobName = normalizeBlobPath(blobName)
  const relativePath = sourcePrefix
    ? normalizedBlobName.slice(sourcePrefix.length).replace(/^\/+/, '')
    : normalizedBlobName
  const firstPathSegment = relativePath.split('/').find(Boolean)
  return firstPathSegment !== undefined && currentDayFolders.has(firstPathSegment)
}

function fileDescriptorFromBlobName(
  blobName: string,
  sourcePrefix: string,
  orgId: string,
  insuranceCompanyCode: string,
  size: number,
): FileDescriptor | null {
  const relativePath = sourcePrefix ? blobName.slice(sourcePrefix.length) : blobName
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
    filePath: blobName,
    fileSizeBytes: size,
    mimeType,
  }
}

function createBlobServiceClient(credentials: Record<string, any>, ctx: string): BlobServiceClient {
  const accountName = requireString(credentials, 'account_name', ctx)
  const accountKey = requireString(credentials, 'account_key', ctx)
  const endpoint = credentials.endpoint
  const endpointStr =
    typeof endpoint === 'string' && endpoint.trim() !== ''
      ? endpoint.trim()
      : `https://${accountName}.blob.core.windows.net`

  const credential = new StorageSharedKeyCredential(accountName, accountKey)
  return new BlobServiceClient(endpointStr, credential)
}

async function listBlobsRecursive(
  containerClient: ContainerClient,
): Promise<Array<{ name: string; size: number }>> {
  const items: Array<{ name: string; size: number }> = []

  for await (const page of containerClient.listBlobsFlat().byPage()) {
    for (const blob of page.segment.blobItems) {
      if (blob.name) {
        items.push({
          name: blob.name,
          size: typeof blob.properties.contentLength === 'number' ? blob.properties.contentLength : 0,
        })
      }
    }
  }

  return items
}

export const azureReaderDriver: ReaderDriver = {
  async listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]> {
    const container = requireString(credentials, 'container', `orgId ${orgId}`)
    const insuranceCompanyCode = requireInsuranceCompanyCode(credentials, `orgId ${orgId}`)
    const sourcePrefix =
      typeof credentials.source_prefix === 'string'
        ? normalizeBlobPath(credentials.source_prefix)
        : ''
    const blobServiceClient = createBlobServiceClient(credentials, `orgId ${orgId}`)
    const containerClient = blobServiceClient.getContainerClient(container)

    const blobs = await listBlobsRecursive(containerClient)
    const out: FileDescriptor[] = []
    const currentDayFolders = currentDayFolderNames()
    for (const blob of blobs) {
      if (blob.name.endsWith('/')) continue
      const normalizedBlobName = normalizeBlobPath(blob.name)
      if (
        sourcePrefix &&
        normalizedBlobName !== sourcePrefix &&
        !normalizedBlobName.startsWith(`${sourcePrefix}/`)
      ) continue
      // Match FTP behavior: only scan today's first-level date folder and
      // ignore older folders before descriptors are created.
      if (!isInCurrentDayFolder(normalizedBlobName, sourcePrefix, currentDayFolders)) continue
      const fd = fileDescriptorFromBlobName(
        normalizedBlobName,
        sourcePrefix,
        orgId,
        insuranceCompanyCode,
        blob.size,
      )
      if (fd) out.push(fd)
    }
    return out
  },

  async readFile(credentials: Record<string, any>, filePath: string): Promise<Readable> {
    const container = requireString(credentials, 'container', 'readFile')
    const blobServiceClient = createBlobServiceClient(credentials, 'readFile')
    const containerClient = blobServiceClient.getContainerClient(container)
    const blobClient = containerClient.getBlobClient(filePath)

    const response = await blobClient.download()
    if (!response.readableStreamBody) {
      throw new Error(`Azure blob "${filePath}" returned no readable stream body.`)
    }

    return response.readableStreamBody as unknown as Readable
  },
}
