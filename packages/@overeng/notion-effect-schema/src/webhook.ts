import { Schema } from 'effect'

const NonEmptyWebhookString = Schema.NonEmptyTrimmedString.annotate({
  identifier: 'NotionWebhook.NonEmptyString',
})

/** Entity reference carried on a Notion webhook event. */
export const NotionWebhookEntity = Schema.Struct({
  id: NonEmptyWebhookString,
  type: NonEmptyWebhookString,
}).annotate({ identifier: 'NotionWebhook.Entity' })

export type NotionWebhookEntity = typeof NotionWebhookEntity.Type

/** Parent reference nested inside `data` on a Notion webhook event. */
export const NotionWebhookParent = Schema.Struct({
  page_id: Schema.optional(NonEmptyWebhookString),
  data_source_id: Schema.optional(NonEmptyWebhookString),
  database_id: Schema.optional(NonEmptyWebhookString),
}).annotate({ identifier: 'NotionWebhook.Parent' })

export type NotionWebhookParent = typeof NotionWebhookParent.Type

/** `data` envelope nested on a Notion webhook event. */
export const NotionWebhookData = Schema.Struct({
  parent: Schema.optional(NotionWebhookParent),
}).annotate({ identifier: 'NotionWebhook.Data' })

export type NotionWebhookData = typeof NotionWebhookData.Type

/**
 * Minimal Notion webhook event payload wire schema.
 *
 * Decode with `onExcessProperty:'preserve'` so unknown/future Notion fields do
 * not fail-close legitimate events (Notion may add fields in minor API bumps).
 */
export const NotionWebhookPayload = Schema.Struct({
  id: Schema.optional(NonEmptyWebhookString),
  event_id: Schema.optional(NonEmptyWebhookString),
  type: NonEmptyWebhookString,
  timestamp: Schema.optional(NonEmptyWebhookString),
  created_time: Schema.optional(NonEmptyWebhookString),
  api_version: Schema.optional(NonEmptyWebhookString),
  attempt_number: Schema.optional(Schema.NonNegativeInt),
  subscription_id: Schema.optional(NonEmptyWebhookString),
  workspace_id: Schema.optional(NonEmptyWebhookString),
  integration_id: Schema.optional(NonEmptyWebhookString),
  is_aggregated: Schema.optional(Schema.Boolean),
  entity: Schema.optional(NotionWebhookEntity),
  data: Schema.optional(NotionWebhookData),
}).annotate({ identifier: 'NotionWebhook.Payload' })

export type NotionWebhookPayload = typeof NotionWebhookPayload.Type

/** Decode options for `NotionWebhookPayload`: preserve unknown fields, collect all errors. */
export const notionWebhookDecodeOptions = {
  errors: 'all',
  onExcessProperty: 'preserve',
} as const
