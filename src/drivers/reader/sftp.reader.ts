/**
 * Source reader implementation for storage-core.
 */
import SftpClient from 'ssh2-sftp-client'
import { PassThrough } from 'stream'
import type { Readable } from 'stream'
import type { FileDescriptor, ReaderDriver } from '../../types'

function requireString(c: Record<string, any>, key: string, ctx: string): string {
  const v = c[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`SFTP sourceCredentials.${key} is missing or empty (${ctx}).`)
  }
  return v
}

function joinPosix(dir: string, name: string): string {
  const d = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return `${d}/${name}`
}

function currentDayFolderNames(now = new Date()): Set<string> {
  const day = String(now.getDate()).padStart(2, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const year = String(now.getFullYear())
  return new Set([`${day}-${month}-${year.slice(-2)}`, `${day}-${month}-${year}`])
}

function requireInsuranceCompanyCode(c: Record<string, any>, ctx: string): string {
  const raw = c.insuranceCompanyCode ?? c.insurance_company_code
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`SFTP sourceCredentials.insuranceCompanyCode is missing or empty (${ctx}).`)
  }
  return raw.trim()
}

function fileDescriptorFromParts(
  parts: string[],
  orgId: string,
  insuranceCompanyCode: string,
  filePath: string,
  fileSizeBytes: number,
): FileDescriptor | null {
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
    filePath,
    fileSizeBytes,
    mimeType,
  }
}

async function walkSftpTree(
  client: SftpClient,
  dir: string,
  orgId: string,
  insuranceCompanyCode: string,
  sourcePrefix: string,
  currentDayFolders: Set<string>,
  out: FileDescriptor[],
  isSourceRoot = false,
): Promise<void> {
  try {
    const list = await client.list(dir)
    for (const ent of list) {
      const name = ent.name
      if (name === '.' || name === '..') continue
      const fullPath = joinPosix(dir, name)
      if (ent.type === 'd') {
        // The source root is expected to contain a date folder. Do not enter
        // older date folders or unrelated directories.
        if (isSourceRoot && !currentDayFolders.has(name)) continue
        await walkSftpTree(
          client,
          fullPath,
          orgId,
          insuranceCompanyCode,
          sourcePrefix,
          currentDayFolders,
          out,
        )
      } else if (ent.type === '-') {
        if (sourcePrefix && !fullPath.startsWith(sourcePrefix)) continue
        const relativePath = sourcePrefix ? fullPath.slice(sourcePrefix.length) : fullPath
        const parts = relativePath.split('/').filter(Boolean)
        const fd = fileDescriptorFromParts(
          parts,
          orgId,
          insuranceCompanyCode,
          fullPath.startsWith('/') ? fullPath : `/${fullPath}`,
          ent.size,
        )
        if (fd) out.push(fd)
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[sftp-reader] Skipping inaccessible directory ${dir}: ${msg}`)
    return
  }
}

export const sftpReaderDriver: ReaderDriver = {
  async listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]> {
    const host = requireString(credentials, 'host', `orgId ${orgId}`)
    const user = requireString(credentials, 'user', `orgId ${orgId}`)
    const password = requireString(credentials, 'password', `orgId ${orgId}`)
    const insuranceCompanyCode = requireInsuranceCompanyCode(credentials, `orgId ${orgId}`)
    const sourcePrefix =
      typeof credentials.source_prefix === 'string' ? credentials.source_prefix : ''
    const port = typeof credentials.port === 'number' && Number.isFinite(credentials.port) ? credentials.port : 22

    const client = new SftpClient()
    const bucket = typeof credentials.bucket === 'string' ? credentials.bucket.trim().replace(/^\//, '') : ''
    const out: FileDescriptor[] = []
    const currentDayFolders = currentDayFolderNames()
    try {
      await client.connect({ host, port, username: user, password })
      const cwd = await client.cwd()
      const root = sourcePrefix || (bucket ? `${cwd}/${bucket}` : cwd)
      await walkSftpTree(
        client,
        root,
        orgId,
        insuranceCompanyCode,
        sourcePrefix,
        currentDayFolders,
        out,
        true,
      )
      return out
    } finally {
      void client.end()
    }
  },

  async readFile(credentials: Record<string, any>, filePath: string): Promise<Readable> {
    const host = requireString(credentials, 'host', 'readFile')
    const user = requireString(credentials, 'user', 'readFile')
    const password = requireString(credentials, 'password', 'readFile')
    const port = typeof credentials.port === 'number' && Number.isFinite(credentials.port) ? credentials.port : 22

    const client = new SftpClient()
    await client.connect({ host, port, username: user, password })

    const stream = new PassThrough({ highWaterMark: 64 * 1024 })
    const readStream = client.createReadStream(filePath)

    readStream.pipe(stream)

    const disconnect = (): void => {
      void client.end()
    }

    readStream.on('end', disconnect)
    readStream.on('error', (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      stream.destroy(e)
      disconnect()
    })

    return stream
  },
}
