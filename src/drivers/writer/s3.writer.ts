/**
 * Landing writer implementation for storage-core.
 */
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { Readable } from 'stream'
import type { TransferResult, WriteInput, WriterDriver } from '../../types'

function requireEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(`${name} env var is not set; cannot write to Sentinel S3 landing bucket.`)
  }
  return v
}

function landingStorageProvider(): string {
  return process.env.STORAGE_PROVIDER?.trim().toUpperCase() || 'S3'
}

function resolveS3Client(): S3Client {
  const region = requireEnv('AWS_REGION')
  const endpoint = process.env.AWS_ENDPOINT?.trim()

  return new S3Client({
    region,
    credentials: {
      accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    },
    ...(endpoint ? { endpoint } : {}),
  })
}

export const s3WriterDriver: WriterDriver = {
  async write(stream: Readable, input: WriteInput, objectKey: string): Promise<TransferResult> {
    const bucket = requireEnv('AWS_BUCKET')

    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes < 0) {
      throw new Error('fileSizeBytes must be a non-negative finite number for S3 streaming upload.')
    }

    const client = resolveS3Client()

    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: objectKey,
        Body: stream,
        ContentType: input.mimeType,
      },
    })

    await upload.done()

    return {
      objectKey,
      bucketName: bucket,
      storageProvider: landingStorageProvider(),
      fileSizeBytes: input.fileSizeBytes,
    }
  },
}
