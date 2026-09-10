/**
 * Shared storage-core contracts for readers, writers, and file descriptors.
 */
import type { Readable } from 'stream'

export interface ReadInput {
  orgId: string
  fileName: string
  mimeType: string
  fileSizeBytes: number
  sourceChannel: string
  /** Raw value object from KMS, passed in by ingestion service */
  sourceCredentials: Record<string, any>
}

export interface WriteInput {
  orgId: string
  insuranceCompanyCode: string
  contextFolder: string
  fileName: string
  mimeType: string
  fileSizeBytes: number
  sourceChannel: string
}

export interface FileDescriptor {
  orgId: string
  insuranceCompanyCode: string
  claimFolder: string
  fileName: string
  filePath: string
  fileSizeBytes: number
  mimeType: string
  // Email-specific (optional — only populated by email.reader.ts)
  emailMeta?: {
    imapUid: number
    /** Mailbox UIDVALIDITY observed during this scan; UIDs are only meaningful within this value (RFC 3501). */
    uidValidity: string | null
    rfcMessageId: string | null
    matchedKeywords: string[]
    isTranscript: boolean
    attachmentSha256?: string
    // The actual file bytes are attached here because email attachments
    // are downloaded during listNewFiles (IMAP requires fetch-then-read,
    // unlike FTP/MinIO where listing and reading are separate calls)
    bufferedContent: Buffer
  }
}

export interface TransferResult {
  objectKey: string
  bucketName: string
  storageProvider: string
  fileSizeBytes: number
}

export interface KafkaEventPayload {
  eventId: string
  timestamp: string
  orgId: string
  insuranceCompanyCode: string
  sourceChannel: string
  payload: {
    fileName: string
    storageProvider: string
    bucketName: string
    objectKey: string
    fileSizeBytes: number
    mimeType: string
  }
}

/**
 * Reader driver: lists and reads from TPA source.
 *
 * Credentials shapes (the raw KMS secret value object, keyed by provider):
 * - FTP:   { provider: 'FTP', host, port, user, password, secure, bucket }
 * - MINIO: { provider: 'MINIO', endpoint, access_key, secret_key, bucket }
 * - EMAIL: { provider: 'EMAIL', email, password, imap_host, imap_port }
 *
 * For the EMAIL provider, `readFile` is NOT the content-retrieval path: email
 * attachments and transcripts are downloaded during `listNewFiles` and attached to
 * each FileDescriptor.emailMeta.bufferedContent. Callers should wrap that buffer in a
 * stream rather than calling `readFile`, which avoids a second IMAP round-trip and
 * works around the fact that IMAP UIDs are not stable filePath identifiers once the
 * mailbox lock is released.
 */
export interface ReaderDriver {
  listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]>
  readFile(credentials: Record<string, any>, filePath: string): Promise<Readable>
}

/** Writer driver: streams to Sentinel landing bucket */
export interface WriterDriver {
  write(stream: Readable, input: WriteInput, objectKey: string): Promise<TransferResult>
}
