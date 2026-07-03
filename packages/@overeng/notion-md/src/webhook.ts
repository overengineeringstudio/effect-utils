import { Effect, Schema, Stream } from 'effect'

import {
  NotionWebhookPayloadSchema,
  notionWebhookDecodeOptions,
  type NotionWebhookPayload as CanonicalNotionWebhookPayload,
} from '@overeng/notion-effect-schema'

import type { WatchTrigger } from './batch.ts'
import * as Observability from './observability.ts'

const decoder = new TextDecoder()

/** Canonical Notion webhook event payload wire schema (shared with datasource-sync). */
export const NotionWebhookPayload = NotionWebhookPayloadSchema
/** @see {@link NotionWebhookPayload} */
export type NotionWebhookPayload = CanonicalNotionWebhookPayload

const decodeWebhookJson = Schema.decodeUnknown(
  Schema.parseJson(NotionWebhookPayload),
  notionWebhookDecodeOptions,
)

/** Expected failure while decoding or normalizing a Notion webhook payload. */
export class NmdWebhookPayloadError extends Schema.TaggedError<NmdWebhookPayloadError>()(
  'NmdWebhookPayloadError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Sync surface indicated by a decoded webhook payload. */
export type NotionWebhookSurface = 'page' | 'data-source' | 'comments' | 'unknown'

/** Secret-safe normalized webhook signal; excludes raw payload material. */
export interface NotionWebhookSignal {
  readonly _tag: 'NotionWebhookSignal'
  readonly provider: 'notion'
  readonly eventId: string
  readonly eventType: string
  readonly surface: NotionWebhookSurface
  readonly occurredAt: string | undefined
  readonly apiVersion: string | undefined
  readonly attemptNumber: number | undefined
  readonly pageId: string | undefined
  readonly dataSourceId: string | undefined
  readonly databaseId: string | undefined
  readonly commentId: string | undefined
  readonly subscriptionId: string | undefined
  readonly workspaceId: string | undefined
  readonly integrationId: string | undefined
  readonly isAggregated: boolean | undefined
}

/** Boundary object documenting why comment webhooks do not trigger body reconciliation. */
export interface CommentWebhookBoundary {
  readonly _tag: 'CommentWebhookBoundary'
  readonly eventId: string
  readonly eventType: string
  readonly commentId: string | undefined
  readonly pageId: string | undefined
  readonly reason: 'comments-api-not-implemented'
}

/** Map from tracked Notion page id to local `.nmd` files watching that page. */
export type PagePathIndex = Readonly<Record<string, readonly string[]>>

const bodyText = (rawBody: string | Uint8Array): string =>
  typeof rawBody === 'string' ? rawBody : decoder.decode(rawBody)

const eventIdOf = (payload: NotionWebhookPayload): string | undefined =>
  payload.id ?? payload.event_id

const entityIdOfType = (opts: {
  readonly payload: NotionWebhookPayload
  readonly type: string
}): string | undefined =>
  opts.payload.entity?.type === opts.type ? opts.payload.entity.id : undefined

const isCommentEvent = (payload: NotionWebhookPayload): boolean =>
  payload.entity?.type === 'comment' || payload.type.includes('comment')

const surfaceOf = (payload: NotionWebhookPayload): NotionWebhookSurface => {
  if (isCommentEvent(payload) === true) return 'comments'
  if (
    entityIdOfType({ payload, type: 'page' }) !== undefined ||
    payload.data?.parent?.page_id !== undefined
  ) {
    return 'page'
  }
  if (
    entityIdOfType({ payload, type: 'data_source' }) !== undefined ||
    payload.data?.parent?.data_source_id !== undefined
  ) {
    return 'data-source'
  }
  return 'unknown'
}

/** Normalize a decoded provider payload into the package's trigger signal shape. */
export const normalizeNotionWebhookPayload = (
  payload: NotionWebhookPayload,
): Effect.Effect<NotionWebhookSignal, NmdWebhookPayloadError> =>
  Effect.gen(function* () {
    const eventId = eventIdOf(payload)
    if (eventId === undefined) {
      return yield* new NmdWebhookPayloadError({
        message: 'Notion webhook payload is missing id/event_id',
      })
    }

    const parent = payload.data?.parent
    const surface = surfaceOf(payload)
    return {
      _tag: 'NotionWebhookSignal',
      provider: 'notion',
      eventId,
      eventType: payload.type,
      surface,
      occurredAt: payload.timestamp ?? payload.created_time,
      apiVersion: payload.api_version,
      attemptNumber: payload.attempt_number,
      pageId: entityIdOfType({ payload, type: 'page' }) ?? parent?.page_id,
      dataSourceId: entityIdOfType({ payload, type: 'data_source' }) ?? parent?.data_source_id,
      databaseId: entityIdOfType({ payload, type: 'database' }) ?? parent?.database_id,
      commentId: entityIdOfType({ payload, type: 'comment' }),
      subscriptionId: payload.subscription_id,
      workspaceId: payload.workspace_id,
      integrationId: payload.integration_id,
      isAggregated: payload.is_aggregated,
    } satisfies NotionWebhookSignal
  })

/** Decode raw webhook JSON into a normalized signal with a decode span. */
export const decodeNotionWebhookSignal = (
  rawBody: string | Uint8Array,
): Effect.Effect<NotionWebhookSignal, NmdWebhookPayloadError> =>
  decodeWebhookJson(bodyText(rawBody)).pipe(
    Effect.mapError(
      (cause) =>
        new NmdWebhookPayloadError({
          cause,
          message: 'Failed to decode Notion webhook payload',
        }),
    ),
    Effect.flatMap(normalizeNotionWebhookPayload),
    Observability.withOperation({
      operation: Observability.WebhookDecodeSpan,
      attributes: { label: 'decode' },
    }),
  )

/** Return the explicit comments-surface boundary for comment webhooks. */
export const commentWebhookBoundary = (
  signal: NotionWebhookSignal,
): CommentWebhookBoundary | undefined =>
  signal.surface === 'comments'
    ? {
        _tag: 'CommentWebhookBoundary',
        eventId: signal.eventId,
        eventType: signal.eventType,
        commentId: signal.commentId,
        pageId: signal.pageId,
        reason: 'comments-api-not-implemented',
      }
    : undefined

/** Map a normalized webhook signal to watch triggers for known local paths. */
export const webhookSignalToWatchTriggers = (opts: {
  readonly signal: NotionWebhookSignal
  readonly pagePathIndex: PagePathIndex
}): Effect.Effect<readonly WatchTrigger[]> => {
  const paths =
    opts.signal.surface === 'page' && opts.signal.pageId !== undefined
      ? (opts.pagePathIndex[opts.signal.pageId] ?? [])
      : []
  const triggers = paths.map((path): WatchTrigger => ({ path, reason: 'webhook' }))
  return Effect.succeed(triggers).pipe(
    Observability.withOperation({
      operation: Observability.WebhookTriggerSpan,
      attributes: {
        eventType: opts.signal.eventType,
        surface: opts.signal.surface,
        triggerCount: triggers.length,
      },
    }),
  )
}

/** Convert raw webhook payload stream into watch triggers for the batch scheduler. */
export const notionWebhookTriggerSource = (opts: {
  readonly rawPayloads: Stream.Stream<string | Uint8Array, never>
  readonly pagePathIndex: PagePathIndex
}): Stream.Stream<WatchTrigger, NmdWebhookPayloadError> =>
  opts.rawPayloads.pipe(
    Stream.mapEffect((rawBody) =>
      decodeNotionWebhookSignal(rawBody).pipe(
        Effect.flatMap((signal) =>
          webhookSignalToWatchTriggers({ signal, pagePathIndex: opts.pagePathIndex }),
        ),
      ),
    ),
    Stream.flatMap((triggers) => Stream.fromIterable(triggers)),
  )
