import { createHmac, timingSafeEqual } from 'node:crypto'

import { Result, Schema } from 'effect'
import { NonEmptyTrimmedString } from '../core/domain.ts'

import {
  type NotionWebhookPayload,
  NotionWebhookPayloadSchema,
  notionWebhookDecodeOptions,
} from '@overeng/notion-effect-schema'

/** Lower-case HTTP header name carrying Notion's HMAC-SHA256 webhook signature. */
export const notionSignatureHeader = 'x-notion-signature'

/** One-time challenge Notion sends while the user verifies a webhook subscription in the UI. */
export type NotionWebhookVerification = {
  readonly _tag: 'NotionWebhookVerification'
  readonly verificationToken: string
}

/** Provider-neutral entity reference from a Notion webhook payload. */
export type NotionWebhookEntity = {
  readonly id: string
  readonly type: string
}

/** Secret-safe webhook invalidation signal; intentionally excludes the raw webhook payload. */
export type NotionWebhookSignal = {
  readonly _tag: 'NotionWebhookSignal'
  readonly provider: 'notion'
  readonly eventId: string
  readonly eventType: string
  readonly occurredAt: string | undefined
  readonly apiVersion: string | undefined
  readonly attemptNumber: number | undefined
  readonly entity: NotionWebhookEntity | undefined
  readonly pageId: string | undefined
  readonly dataSourceId: string | undefined
  readonly databaseId: string | undefined
  readonly subscriptionId: string | undefined
  readonly workspaceId: string | undefined
  readonly integrationId: string | undefined
  readonly isAggregated: boolean | undefined
}

/** Result of parsing a Notion webhook request body and optional signature. */
export type NotionWebhookParseResult =
  | NotionWebhookVerification
  | { readonly _tag: 'NotionWebhookEvent'; readonly signal: NotionWebhookSignal }
  | { readonly _tag: 'NotionWebhookRejected'; readonly reason: NotionWebhookRejectionReason }

/** Stable rejection reasons suitable for status output without including raw payload material. */
export type NotionWebhookRejectionReason =
  | 'invalid-json'
  | 'invalid-payload-shape'
  | 'missing-verification-token'
  | 'missing-signature'
  | 'malformed-signature'
  | 'signature-mismatch'
  | 'missing-event-id'

/** Minimal header lookup shape accepted by webhook helpers and HTTP server adapters. */
export type HeaderLookup =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>

/** Raw webhook request material needed for signature validation and parsing. */
export type NotionWebhookRequestInput = {
  readonly rawBody: string | Uint8Array
  readonly headers: HeaderLookup
  readonly verificationToken?: string
}

const textDecoder = new TextDecoder()

const rawBodyBytes = (rawBody: string | Uint8Array): Uint8Array =>
  typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody

const rawBodyText = (rawBody: string | Uint8Array): string =>
  typeof rawBody === 'string' ? rawBody : textDecoder.decode(rawBody)

/** Decode a raw body string into a JSON value, returning Either. */
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Decode a JSON value into `NotionWebhookPayload`, returning Either. */
const decodePayload = Schema.decodeUnknownResult(
  NotionWebhookPayloadSchema,
  notionWebhookDecodeOptions,
)

/**
 * One-time verification-token challenge schema (unauthenticated, no signature).
 * A normal event payload will fail this decode — that is "fall through," not a rejection.
 */
const NotionWebhookVerificationStruct = Schema.Struct({
  // NonEmptyTrimmedString trims then checks: a whitespace-only token (e.g. "   ")
  // intentionally fails this decode and falls through to the HMAC gate rather than
  // being treated as a (meaningless) verification challenge.
  verification_token: NonEmptyTrimmedString,
}).annotate({ identifier: 'NotionWebhook.VerificationStruct' })

const decodeVerification = Schema.decodeUnknownResult(NotionWebhookVerificationStruct, {
  onExcessProperty: 'preserve',
})

/** Parse Notion's unauthenticated one-time verification-token request. */
export const parseNotionWebhookVerification = (
  rawBody: string | Uint8Array,
):
  | NotionWebhookVerification
  | { readonly _tag: 'NotionWebhookRejected'; readonly reason: NotionWebhookRejectionReason } => {
  const jsonResult = decodeJson(rawBodyText(rawBody))
  if (Result.isFailure(jsonResult) === true) return { _tag: 'NotionWebhookRejected', reason: 'invalid-json' }
  const verResult = decodeVerification(jsonResult.success)
  if (Result.isFailure(verResult) === true) {
    return { _tag: 'NotionWebhookRejected', reason: 'missing-verification-token' }
  }
  return {
    _tag: 'NotionWebhookVerification',
    verificationToken: verResult.success.verification_token,
  }
}

const headerValue = ({
  headers,
  name,
}: {
  readonly headers: HeaderLookup
  readonly name: string
}): string | undefined => {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue
    if (Array.isArray(value) === true) return value[0]
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

const parseSignature = (
  signatureHeader: string | undefined,
):
  | { readonly _tag: 'ok'; readonly signature: Uint8Array }
  | {
      readonly _tag: 'error'
      readonly reason: Extract<
        NotionWebhookRejectionReason,
        'missing-signature' | 'malformed-signature'
      >
    } => {
  if (signatureHeader === undefined || signatureHeader.length === 0) {
    return { _tag: 'error', reason: 'missing-signature' }
  }
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader)
  if (match === null) return { _tag: 'error', reason: 'malformed-signature' }
  return { _tag: 'ok', signature: Buffer.from(match[1]!, 'hex') }
}

/** Compute Notion's expected `X-Notion-Signature` value for an exact raw request body. */
export const computeNotionWebhookSignature = ({
  rawBody,
  verificationToken,
}: {
  readonly rawBody: string | Uint8Array
  readonly verificationToken: string
}): string =>
  `sha256=${createHmac('sha256', verificationToken).update(rawBodyBytes(rawBody)).digest('hex')}`

/** Verify `X-Notion-Signature` with timing-safe comparison and no raw-body logging. */
export const verifyNotionWebhookSignature = ({
  rawBody,
  verificationToken,
  signatureHeader,
}: {
  readonly rawBody: string | Uint8Array
  readonly verificationToken: string
  readonly signatureHeader: string | undefined
}):
  | { readonly _tag: 'valid' }
  | {
      readonly _tag: 'invalid'
      readonly reason: Extract<
        NotionWebhookRejectionReason,
        'missing-signature' | 'malformed-signature' | 'signature-mismatch'
      >
    } => {
  const parsed = parseSignature(signatureHeader)
  if (parsed._tag === 'error') return { _tag: 'invalid', reason: parsed.reason }
  const expected = createHmac('sha256', verificationToken).update(rawBodyBytes(rawBody)).digest()
  if (parsed.signature.byteLength !== expected.byteLength) {
    return { _tag: 'invalid', reason: 'signature-mismatch' }
  }
  return timingSafeEqual(parsed.signature, expected) === true
    ? { _tag: 'valid' }
    : { _tag: 'invalid', reason: 'signature-mismatch' }
}

/** Map a decoded `NotionWebhookPayload` to nds's provider-neutral invalidation signal. */
export const normalizeNotionWebhookPayload = (
  payload: NotionWebhookPayload,
):
  | NotionWebhookSignal
  | { readonly _tag: 'NotionWebhookRejected'; readonly reason: NotionWebhookRejectionReason } => {
  const eventId = payload.id ?? payload.event_id
  if (eventId === undefined) return { _tag: 'NotionWebhookRejected', reason: 'missing-event-id' }

  // Reconstruct entity explicitly to drop any excess fields that survived the
  // onExcessProperty:'preserve' decoder — signal.entity must not carry raw payload material.
  const rawEntity = payload.entity
  const entity = rawEntity === undefined ? undefined : { id: rawEntity.id, type: rawEntity.type }
  const entityId = entity?.id
  const entityType = entity?.type
  const parent = payload.data?.parent
  return {
    _tag: 'NotionWebhookSignal',
    provider: 'notion',
    eventId,
    eventType: payload.type,
    occurredAt: payload.timestamp ?? payload.created_time,
    apiVersion: payload.api_version,
    attemptNumber: payload.attempt_number,
    entity,
    pageId: entityType === 'page' ? entityId : undefined,
    dataSourceId: entityType === 'data_source' ? entityId : parent?.data_source_id,
    databaseId: entityType === 'database' ? entityId : parent?.database_id,
    subscriptionId: payload.subscription_id,
    workspaceId: payload.workspace_id,
    integrationId: payload.integration_id,
    isAggregated: payload.is_aggregated,
  }
}

/**
 * Parse a complete Notion webhook request, including signature checks when a token exists.
 *
 * Fail-closed ordering:
 * 1. JSON parse  → 'invalid-json' on failure
 * 2. Verification-token branch (unauthenticated, no signature required)
 * 3. HMAC signature gate (strictly before shape decode)
 * 4. Shape decode via `NotionWebhookPayload` schema → 'invalid-payload-shape' on failure
 * 5. Normalize decoded payload → 'missing-event-id' if absent
 */
export const parseNotionWebhookRequest = ({
  rawBody,
  headers,
  verificationToken,
}: NotionWebhookRequestInput): NotionWebhookParseResult => {
  // Step 1: JSON parse
  const jsonResult = decodeJson(rawBodyText(rawBody))
  if (Result.isFailure(jsonResult) === true) return { _tag: 'NotionWebhookRejected', reason: 'invalid-json' }
  const jsonValue = jsonResult.success

  // Step 2: unauthenticated verification-token branch
  const verResult = decodeVerification(jsonValue)
  if (Result.isSuccess(verResult) === true) {
    return {
      _tag: 'NotionWebhookVerification',
      verificationToken: verResult.success.verification_token,
    }
  }

  // Step 3: HMAC signature gate (strictly before shape decode)
  if (verificationToken !== undefined) {
    const signature = verifyNotionWebhookSignature({
      rawBody,
      verificationToken,
      signatureHeader: headerValue({ headers, name: notionSignatureHeader }),
    })
    if (signature._tag === 'invalid') {
      return { _tag: 'NotionWebhookRejected', reason: signature.reason }
    }
  }

  // Step 4: shape decode
  const payloadResult = decodePayload(jsonValue)
  if (Result.isFailure(payloadResult) === true) {
    return { _tag: 'NotionWebhookRejected', reason: 'invalid-payload-shape' }
  }

  // Step 5: normalize
  const signal = normalizeNotionWebhookPayload(payloadResult.success)
  return signal._tag === 'NotionWebhookRejected' ? signal : { _tag: 'NotionWebhookEvent', signal }
}
