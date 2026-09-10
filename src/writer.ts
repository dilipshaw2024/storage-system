/**
 * Provider dispatcher for landing uploads and metadata publishing.
 */
import { randomUUID } from 'crypto'
import type { Readable } from 'stream'
import { publishEvent } from './kafka-client'
import type { KafkaEventPayload, TransferResult, WriteInput } from './types'
import { azureWriterDriver } from './drivers/writer/azure.writer'
import { gcpWriterDriver } from './drivers/writer/gcp.writer'
import { minioWriterDriver } from './drivers/writer/minio.writer'
import { s3WriterDriver } from './drivers/writer/s3.writer'

function buildObjectKey(input: WriteInput): string {
  const date = new Date().toISOString().split('T')[0]
  const channel = input.sourceChannel.toLowerCase().replace('_ingestion', '')
  return `${input.orgId}/${input.insuranceCompanyCode}/${date}/${channel}/${input.contextFolder}/${input.fileName}`
}

function buildKafkaPayload(input: WriteInput, result: TransferResult): KafkaEventPayload {
  return {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    orgId: input.orgId,
    insuranceCompanyCode: input.insuranceCompanyCode,
    sourceChannel: input.sourceChannel,
    payload: {
      fileName: input.fileName,
      storageProvider: result.storageProvider,
      bucketName: result.bucketName,
      objectKey: result.objectKey,
      fileSizeBytes: result.fileSizeBytes,
      mimeType: input.mimeType,
    },
  }
}

export async function writeToLanding(stream: Readable, input: WriteInput): Promise<TransferResult> {
  const provider = process.env.STORAGE_PROVIDER?.trim().toUpperCase() || 'S3'
  const objectKey = buildObjectKey(input)
  let result: TransferResult
  switch (provider) {
    case 'MINIO':
      result = await minioWriterDriver.write(stream, input, objectKey)
      break
    case 'S3':
      result = await s3WriterDriver.write(stream, input, objectKey)
      break
    case 'GCP':
      result = await gcpWriterDriver.write(stream, input, objectKey)
      break
    case 'AZURE':
      result = await azureWriterDriver.write(stream, input, objectKey)
      break
    default:
      throw new Error(
        `Unsupported STORAGE_PROVIDER "${provider}". Expected one of: MINIO, S3, GCP, AZURE`
      )
  }
  try {
    await publishEvent(buildKafkaPayload(input, result))
  } catch (err) {
    console.error('[storage-core] Kafka publish failed (file already uploaded):', err)
  }
  return result
}
