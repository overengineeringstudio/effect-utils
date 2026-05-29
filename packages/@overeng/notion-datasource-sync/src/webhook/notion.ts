import { createHmac, timingSafeEqual } from 'node:crypto'

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
  | 'missing-verification-token'
  | 'missing-signature'
  | 'malformed-signature'
  | 'signature-mismatch'
  | 'missing-event-type'
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

const parseJsonObject = (
  rawBody: string | Uint8Array,
):
  | { readonly _tag: 'ok'; readonly value: Readonly<Record<string, unknown>> }
  | {
      readonly _tag: 'error'
    } => {
  try {
    const parsed = JSON.parse(rawBodyText(rawBody)) as unknown
    return isRecord(parsed) === true ? { _tag: 'ok', value: parsed } : { _tag: 'error' }
  } catch {
    return { _tag: 'error' }
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

const stringField = ({
  record,
  key,
}: {
  readonly record: Readonly<Record<string, unknown>>
  readonly key: string
}): string | undefined =>
  typeof record[key] === 'string' && record[key].length > 0 ? record[key] : undefined

const numberField = ({
  record,
  key,
}: {
  readonly record: Readonly<Record<string, unknown>>
  readonly key: string
}): number | undefined =>
  typeof record[key] === 'number' && Number.isFinite(record[key]) === true ? record[key] : undefined

const booleanField = ({
  record,
  key,
}: {
  readonly record: Readonly<Record<string, unknown>>
  readonly key: string
}): boolean | undefined => (typeof record[key] === 'boolean' ? record[key] : undefined)

const recordField = ({
  record,
  key,
}: {
  readonly record: Readonly<Record<string, unknown>>
  readonly key: string
}): Readonly<Record<string, unknown>> | undefined =>
  isRecord(record[key]) === true ? record[key] : undefined

/** Parse Notion's unauthenticated one-time verification-token request. */
export const parseNotionWebhookVerification = (
  rawBody: string | Uint8Array,
):
  | NotionWebhookVerification
  | { readonly _tag: 'NotionWebhookRejected'; readonly reason: NotionWebhookRejectionReason } => {
  const parsed = parseJsonObject(rawBody)
  if (parsed._tag === 'error') return { _tag: 'NotionWebhookRejected', reason: 'invalid-json' }
  const verificationToken = stringField({ record: parsed.value, key: 'verification_token' })
  if (verificationToken === undefined) {
    return { _tag: 'NotionWebhookRejected', reason: 'missing-verification-token' }
  }
  return { _tag: 'NotionWebhookVerification', verificationToken }
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

const entityFromPayload = (
  payload: Readonly<Record<string, unknown>>,
): NotionWebhookEntity | undefined => {
  const entity = recordField({ record: payload, key: 'entity' })
  if (entity === undefined) return undefined
  const id = stringField({ record: entity, key: 'id' })
  const type = stringField({ record: entity, key: 'type' })
  return id === undefined || type === undefined ? undefined : { id, type }
}

const parentIds = (payload: Readonly<Record<string, unknown>>) => {
  const data = recordField({ record: payload, key: 'data' })
  const parent = data === undefined ? undefined : recordField({ record: data, key: 'parent' })
  return {
    dataSourceId:
      parent === undefined ? undefined : stringField({ record: parent, key: 'data_source_id' }),
    databaseId:
      parent === undefined ? undefined : stringField({ record: parent, key: 'database_id' }),
  }
}

/** Normalize a Notion event payload into a provider-neutral invalidation signal. */
export const normalizeNotionWebhookPayload = (
  payload: Readonly<Record<string, unknown>>,
):
  | NotionWebhookSignal
  | { readonly _tag: 'NotionWebhookRejected'; readonly reason: NotionWebhookRejectionReason } => {
  const eventType = stringField({ record: payload, key: 'type' })
  if (eventType === undefined)
    return { _tag: 'NotionWebhookRejected', reason: 'missing-event-type' }
  const eventId =
    stringField({ record: payload, key: 'id' }) ?? stringField({ record: payload, key: 'event_id' })
  if (eventId === undefined) return { _tag: 'NotionWebhookRejected', reason: 'missing-event-id' }

  const entity = entityFromPayload(payload)
  const parent = parentIds(payload)
  const entityId = entity?.id
  const entityType = entity?.type
  return {
    _tag: 'NotionWebhookSignal',
    provider: 'notion',
    eventId,
    eventType,
    occurredAt:
      stringField({ record: payload, key: 'timestamp' }) ??
      stringField({ record: payload, key: 'created_time' }),
    apiVersion: stringField({ record: payload, key: 'api_version' }),
    attemptNumber: numberField({ record: payload, key: 'attempt_number' }),
    entity,
    pageId: entityType === 'page' ? entityId : undefined,
    dataSourceId: entityType === 'data_source' ? entityId : parent.dataSourceId,
    databaseId: entityType === 'database' ? entityId : parent.databaseId,
    subscriptionId: stringField({ record: payload, key: 'subscription_id' }),
    workspaceId: stringField({ record: payload, key: 'workspace_id' }),
    integrationId: stringField({ record: payload, key: 'integration_id' }),
    isAggregated: booleanField({ record: payload, key: 'is_aggregated' }),
  }
}

/** Parse a complete Notion webhook request, including signature checks when a token exists. */
export const parseNotionWebhookRequest = ({
  rawBody,
  headers,
  verificationToken,
}: NotionWebhookRequestInput): NotionWebhookParseResult => {
  const parsed = parseJsonObject(rawBody)
  if (parsed._tag === 'error') return { _tag: 'NotionWebhookRejected', reason: 'invalid-json' }

  if (stringField({ record: parsed.value, key: 'verification_token' }) !== undefined) {
    return parseNotionWebhookVerification(rawBody)
  }

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

  const signal = normalizeNotionWebhookPayload(parsed.value)
  return signal._tag === 'NotionWebhookRejected' ? signal : { _tag: 'NotionWebhookEvent', signal }
}
