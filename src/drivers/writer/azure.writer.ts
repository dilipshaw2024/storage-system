/**
 * Landing writer implementation for storage-core.
 */
import type { Readable } from 'stream'
import type { TransferResult, WriteInput, WriterDriver } from '../../types'

export const azureWriterDriver: WriterDriver = {
  async write(_stream: Readable, _input: WriteInput, _objectKey: string): Promise<TransferResult> {
    throw new Error('S3/GCP/Azure writer not yet implemented')
  },
}
