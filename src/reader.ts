/**
 * Provider dispatcher for source-side file listing and reads.
 */
import type { Readable } from 'stream'
import type { FileDescriptor, ReadInput, ReaderDriver } from './types'
import { azureReaderDriver } from './drivers/reader/azure.reader'
import { emailReaderDriver } from './drivers/reader/email.reader'
import { ftpReaderDriver } from './drivers/reader/ftp.reader'
import { sftpReaderDriver } from './drivers/reader/sftp.reader'
import { gcpReaderDriver } from './drivers/reader/gcp.reader'
import { minioReaderDriver } from './drivers/reader/minio.reader'
import { s3ReaderDriver } from './drivers/reader/s3.reader'

export async function listNewFiles(input: ReadInput): Promise<FileDescriptor[]> {
  const provider = resolveProvider(input.sourceCredentials)
  const driver = resolveDriver(provider)
  return driver.listNewFiles(input.orgId, input.sourceCredentials)
}

export async function readFromSource(input: ReadInput & { filePath: string }): Promise<Readable> {
  const provider = resolveProvider(input.sourceCredentials)
  const driver = resolveDriver(provider)
  return driver.readFile(input.sourceCredentials, input.filePath)
}

function resolveProvider(credentials: Record<string, any>): string {
  const provider = credentials?.provider
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('sourceCredentials.provider is missing or empty.')
  }
  return provider.trim().toUpperCase()
}

function resolveDriver(provider: string): ReaderDriver {
  switch (provider) {
    case 'FTP':
      return ftpReaderDriver
    case 'SFTP':
      return sftpReaderDriver
    case 'MINIO':
      return minioReaderDriver
    case 'EMAIL':
      return emailReaderDriver
    case 'S3':
      return s3ReaderDriver
    case 'GCP':
      return gcpReaderDriver
    case 'AZURE':
      return azureReaderDriver
    default:
      throw new Error(
        `Unsupported source provider "${provider}". Expected: FTP, SFTP, MINIO, EMAIL, S3, GCP, AZURE`
      )
  }
}
