import { Schema } from 'effect'

import { DataSourceId, PageId } from './domain.ts'
import { SyncRootId } from './events.ts'

/** Stable local identifier for a durable wake signal in the SQLite inbox. */
export const SignalId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SignalId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SignalId' }),
)
export type SignalId = typeof SignalId.Type

/** Provider or transport that delivered the signal, for example a webhook bridge or manual test source. */
export const SignalProvider = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SignalProvider'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SignalProvider' }),
)
export type SignalProvider = typeof SignalProvider.Type

/** Provider-scoped idempotency key for deduping repeated signal deliveries. */
export const SignalExternalId = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('NotionDatasourceSync.SignalExternalId'),
  Schema.annotations({ identifier: 'NotionDatasourceSync.SignalExternalId' }),
)
export type SignalExternalId = typeof SignalExternalId.Type

/** Stage-1 signals only wake the existing full sync path; payload hints are stored but not used for targeted pulls. */
export const SignalKind = Schema.Literal('remote-change').annotations({
  identifier: 'NotionDatasourceSync.SignalKind',
})
export type SignalKind = typeof SignalKind.Type

/** Durable inbox lifecycle for signal processing. */
export const SignalState = Schema.Literal('pending', 'claimed', 'processed', 'failed').annotations({
  identifier: 'NotionDatasourceSync.SignalState',
})
export type SignalState = typeof SignalState.Type

/** JSON payload captured from the provider. It is deliberately opaque to keep the inbox provider-neutral. */
export const SignalPayloadJson = Schema.String.annotations({
  identifier: 'NotionDatasourceSync.SignalPayloadJson',
})
export type SignalPayloadJson = typeof SignalPayloadJson.Type

/** Decoded row from the durable signal inbox. */
export const SignalInboxRecord = Schema.Struct({
  rootId: SyncRootId,
  signalId: SignalId,
  provider: SignalProvider,
  externalId: SignalExternalId,
  kind: SignalKind,
  payloadJson: SignalPayloadJson,
  state: SignalState,
  dataSourceId: Schema.optional(DataSourceId),
  pageId: Schema.optional(PageId),
  attemptCount: Schema.NonNegativeInt,
  leaseToken: Schema.optional(Schema.String),
  claimedAt: Schema.optional(Schema.String),
  processedAt: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.SignalInboxRecord' })
export type SignalInboxRecord = typeof SignalInboxRecord.Type

/** Aggregated signal inbox counters used by daemon wake decisions and health/status reporting. */
export const SignalInboxStatus = Schema.Struct({
  pending: Schema.NonNegativeInt,
  claimed: Schema.NonNegativeInt,
  processed: Schema.NonNegativeInt,
  failed: Schema.NonNegativeInt,
}).annotations({ identifier: 'NotionDatasourceSync.SignalInboxStatus' })
export type SignalInboxStatus = typeof SignalInboxStatus.Type

/** Input for inserting a durable remote-change wake signal into the sync store. */
export type EnqueueSignalInput = {
  readonly rootId: SyncRootId
  readonly signalId: SignalId
  readonly provider: SignalProvider
  readonly externalId: SignalExternalId
  readonly kind?: SignalKind
  readonly payloadJson?: SignalPayloadJson
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
}

/** Input for leasing the next pending signal before a daemon cycle. */
export type ClaimSignalInput = {
  readonly rootId: SyncRootId
  readonly leaseToken: string
  readonly leaseDurationMs?: number
}

/** Input for marking a leased signal as processed after a successful sync cycle. */
export type SettleSignalInput = {
  readonly rootId: SyncRootId
  readonly signalId: SignalId
  readonly leaseToken: string
}

/** Input for releasing or failing a leased signal after an interrupted sync cycle. */
export type ReleaseSignalInput = {
  readonly rootId: SyncRootId
  readonly signalId: SignalId
  readonly leaseToken: string
  readonly error: string
  readonly failed?: boolean
}
