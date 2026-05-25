import { createHash } from 'node:crypto'

import { Schema } from 'effect'

import { Hash } from './domain.ts'
import type { SyncEvent } from './events.ts'
import { PROJECTOR_VERSION } from './store-schema.ts'

export const OutboxState = Schema.Literal(
  'queued',
  'running',
  'retryable',
  'blocked',
  'settled',
  'fenced',
  'ambiguous',
).annotations({ identifier: 'NotionDatasourceSync.OutboxState' })
export type OutboxState = typeof OutboxState.Type

export type ProjectionDigestInput = {
  readonly sequence: bigint
  readonly eventId: string
  readonly payloadHash: string
}

export const hashStoreBytes = (value: string): Hash =>
  Schema.decodeSync(Hash)(`sha256:${createHash('sha256').update(value).digest('hex')}`)

export const computeProjectionDigest = (events: ReadonlyArray<ProjectionDigestInput>): Hash => {
  const lines = events.map(
    (event) =>
      `${PROJECTOR_VERSION}\t${event.sequence.toString()}\t${event.eventId}\t${event.payloadHash}`,
  )

  return hashStoreBytes(`${lines.join('\n')}\n`)
}

export const computePayloadHash = (event: SyncEvent): Hash =>
  hashStoreBytes(event.payload.canonicalJson)

export const isCompactionBlockingOutboxState = (state: OutboxState): boolean =>
  state === 'queued' || state === 'running' || state === 'retryable' || state === 'ambiguous'
