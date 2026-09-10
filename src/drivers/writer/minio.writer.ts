/**
 * Landing writer implementation for storage-core.
 */
import * as Minio from 'minio'
import type { Readable } from 'stream'
import type { TransferResult, WriteInput, WriterDriver } from '../../types'

function requireEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(`${name} env var is not set; cannot write to Sentinel MinIO landing bucket.`)
  }
  return v
}

function parseMinioEndpoint(endpoint: string): { endPoint: string; port: number; useSSL: boolean } {
  const trimmed = endpoint.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    const useSSL = url.protocol === 'https:'
    const port = url.port ? parseInt(url.port, 10) : useSSL ? 443 : 80
    return { endPoint: url.hostname, port, useSSL }
  }
  const idx = trimmed.lastIndexOf(':')
  if (idx > 0) {
    const host = trimmed.slice(0, idx)
    const port = parseInt(trimmed.slice(idx + 1), 10)
    if (host && !Number.isNaN(port)) {
      return { endPoint: host, port, useSSL: port === 443 }
    }
  }
  return { endPoint: trimmed, port: 80, useSSL: false }
}

function resolveLandingMinioClientOptions(): { endPoint: string; port: number; useSSL: boolean } {
  const raw = requireEnv('MINIO_ENDPOINT')
  if (/^https?:\/\//i.test(raw)) {
    return parseMinioEndpoint(raw)
  }
  const port = parseInt(process.env.MINIO_PORT?.trim() || '9000', 10)
  const useSSL = process.env.MINIO_USE_SSL?.trim().toLowerCase() === 'true'
  return { endPoint: raw, port, useSSL }
}

function landingStorageProvider(): string {
  return process.env.STORAGE_PROVIDER?.trim().toUpperCase() || 'MINIO'
}

export const minioWriterDriver: WriterDriver = {
  async write(stream: Readable, input: WriteInput, objectKey: string): Promise<TransferResult> {
    const accessKey = requireEnv('MINIO_ACCESS_KEY')
    const secretKey = requireEnv('MINIO_SECRET_KEY')
    const bucket = requireEnv('MINIO_BUCKET')

    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes < 0) {
      throw new Error('fileSizeBytes must be a non-negative finite number for MinIO streaming upload.')
    }

    const { endPoint, port, useSSL } = resolveLandingMinioClientOptions()
    const client = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    })

    const metaData: Record<string, string> = {
      'Content-Type': input.mimeType,
    }

    await client.putObject(bucket, objectKey, stream, input.fileSizeBytes, metaData)

    return {
      objectKey,
      bucketName: bucket,
      storageProvider: landingStorageProvider(),
      fileSizeBytes: input.fileSizeBytes,
    }
  },
}
