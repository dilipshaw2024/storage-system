/**
 * Kafka producer helper used by storage-core after landing writes.
 */
import { Kafka, Producer } from 'kafkajs'
import type { KafkaEventPayload } from './types'

const INGESTION_EVENTS_TOPIC = 'ingestion-events'

let producer: Producer | null = null
let connectPromise: Promise<Producer> | null = null

function isProducerDisconnected(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /disconnected/i.test(err.message)
}

async function createConnectedProducer(): Promise<Producer> {
  const brokerList = process.env.KAFKA_BROKER?.trim()
  if (!brokerList) throw new Error('KAFKA_BROKER is not set.')

  const brokers = brokerList.split(',').map(b => b.trim()).filter(Boolean)
  if (brokers.length === 0) throw new Error('KAFKA_BROKER has no valid addresses.')

  const kafka = new Kafka({ clientId: 'sentinel-storage-core', brokers })
  const p = kafka.producer()
  await p.connect()
  producer = p
  return p
}

async function getProducer(): Promise<Producer> {
  if (producer) return producer
  if (connectPromise) return connectPromise

  connectPromise = createConnectedProducer()
  try {
    return await connectPromise
  } finally {
    connectPromise = null
  }
}

async function resetProducer(): Promise<void> {
  if (producer) {
    try {
      await producer.disconnect()
    } catch {
      // ignore disconnect errors while resetting a dead producer
    }
  }
  producer = null
  connectPromise = null
}

export async function publishEvent(payload: KafkaEventPayload): Promise<void> {
  try {
    const p = await getProducer()
    await p.send({
      topic: INGESTION_EVENTS_TOPIC,
      messages: [{ key: payload.orgId, value: JSON.stringify(payload) }],
    })
  } catch (err) {
    if (!isProducerDisconnected(err)) throw err
    await resetProducer()
    const p = await getProducer()
    await p.send({
      topic: INGESTION_EVENTS_TOPIC,
      messages: [{ key: payload.orgId, value: JSON.stringify(payload) }],
    })
  }
}
