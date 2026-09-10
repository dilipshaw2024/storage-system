/**
 * Source reader implementation for storage-core.
 */
import { Client, FileType } from 'basic-ftp'
import { PassThrough } from 'stream'
import type { Readable } from 'stream'
import type { FileDescriptor, ReaderDriver } from '../../types'

function formatFtpContext(
  orgId: string,
  host: string,
  port: number,
  root: string,
  sourcePrefix: string,
): string {
  return `orgId=${orgId}, host=${host}, port=${port}, root=${root}, sourcePrefix=${sourcePrefix || '<empty>'}`
}

function wrapFtpError(
  scope: string,
  ctx: string,
  error: unknown,
): Error {
  const cause = error instanceof Error ? error : new Error(String(error))
  return new Error(`[ftp-reader] ${scope} failed (${ctx}): ${cause.message}`, {
    cause,
  })
}

function requireString(c: Record<string, any>, key: string, ctx: string): string {
  const v = c[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`FTP sourceCredentials.${key} is missing or empty (${ctx}).`)
  }
  return v
}

function joinPosix(dir: string, name: string): string {
  const d = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return `${d}/${name}`
}

function normalizeFtpPath(path: string): string {
  return path.trim().replace(/^\/+/, '').replace(/\/+$/, '')
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
    throw new Error(`FTP sourceCredentials.insuranceCompanyCode is missing or empty (${ctx}).`)
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

async function walkFtpTree(
  client: Client,
  dir: string,
  orgId: string,
  insuranceCompanyCode: string,
  sourcePrefix: string,
  currentDayFolders: Set<string>,
  out: FileDescriptor[],
  isSourceRoot = false,
): Promise<void> {
  const list = await client.list(dir)
  for (const ent of list) {
    const name = ent.name
    if (name === '.' || name === '..') continue
    const fullPath = joinPosix(dir, name)
    if (ent.type === FileType.Directory) {
      // The source root is expected to contain a date folder. Do not enter
      // older date folders or unrelated directories.
      if (isSourceRoot && !currentDayFolders.has(name)) continue
      await walkFtpTree(
        client,
        fullPath,
        orgId,
        insuranceCompanyCode,
        sourcePrefix,
        currentDayFolders,
        out,
      )
    } else if (ent.type === FileType.File) {
      const normalizedFullPath = normalizeFtpPath(fullPath)
      if (
        sourcePrefix &&
        normalizedFullPath !== sourcePrefix &&
        !normalizedFullPath.startsWith(`${sourcePrefix}/`)
      ) {
        continue
      }
      const relativePath = sourcePrefix
        ? normalizedFullPath.slice(sourcePrefix.length)
        : normalizedFullPath
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
}

export const ftpReaderDriver: ReaderDriver = {
  async listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]> {
    const host = requireString(credentials, 'host', `orgId ${orgId}`)
    const user = requireString(credentials, 'user', `orgId ${orgId}`)
    const password = requireString(credentials, 'password', `orgId ${orgId}`)
    const insuranceCompanyCode = requireInsuranceCompanyCode(credentials, `orgId ${orgId}`)
    const sourcePrefix =
      typeof credentials.source_prefix === 'string'
        ? normalizeFtpPath(credentials.source_prefix)
        : ''
    const port = typeof credentials.port === 'number' && Number.isFinite(credentials.port) ? credentials.port : 21

    let secure: boolean | 'implicit' = false
    if (credentials.secure === true || credentials.secure === 'true' || credentials.explicit_tls === true) {
      secure = true
    } else if (credentials.secure === 'implicit' || credentials.implicit_tls === true) {
      secure = 'implicit'
    }

    const client = new Client()
    const configuredRoot =
      typeof credentials.bucket === 'string' && credentials.bucket.trim() !== ''
        ? `/${normalizeFtpPath(credentials.bucket)}`
        : '/'
    const root = sourcePrefix ? `/${sourcePrefix}` : configuredRoot
    const out: FileDescriptor[] = []
    const currentDayFolders = currentDayFolderNames()
    const ctx = formatFtpContext(orgId, host, port, root, sourcePrefix)
    try {
      try {
        await client.access({ host, port, user, password, secure })
      } catch (error) {
        throw wrapFtpError('connect', ctx, error)
      }

      try {
        await walkFtpTree(
          client,
          root,
          orgId,
          insuranceCompanyCode,
          sourcePrefix,
          currentDayFolders,
          out,
          true,
        )
      } catch (error) {
        throw wrapFtpError('scan', ctx, error)
      }
      return out
    } finally {
      void client.close()
    }
  },

  async readFile(credentials: Record<string, any>, filePath: string): Promise<Readable> {
    const host = requireString(credentials, 'host', 'readFile')
    const user = requireString(credentials, 'user', 'readFile')
    const password = requireString(credentials, 'password', 'readFile')
    const port = typeof credentials.port === 'number' && Number.isFinite(credentials.port) ? credentials.port : 21

    let secure: boolean | 'implicit' = false
    if (credentials.secure === true || credentials.secure === 'true' || credentials.explicit_tls === true) {
      secure = true
    } else if (credentials.secure === 'implicit' || credentials.implicit_tls === true) {
      secure = 'implicit'
    }

    const client = new Client()
    try {
      await client.access({ host, port, user, password, secure })
    } catch (error) {
      throw wrapFtpError('connect-read', `host=${host}, port=${port}, filePath=${filePath}`, error)
    }

    const stream = new PassThrough({ highWaterMark: 64 * 1024 })

    void client
      .downloadTo(stream, filePath)
      .catch((err: unknown) => {
        const e = wrapFtpError(
          'download',
          `host=${host}, port=${port}, filePath=${filePath}`,
          err,
        )
        stream.destroy(e)
      })
      .finally(() => {
        void client.close()
      })

    return stream
  },
}
