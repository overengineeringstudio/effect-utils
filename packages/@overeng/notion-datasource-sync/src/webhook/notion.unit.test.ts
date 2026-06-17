import { describe, expect, it } from 'vitest'

import {
  computeNotionWebhookSignature,
  normalizeNotionWebhookPayload,
  parseNotionWebhookRequest,
  parseNotionWebhookVerification,
  verifyNotionWebhookSignature,
} from './notion.ts'

const verificationToken = 'secret-verification-token'

describe('Notion webhook receiver helpers', () => {
  it('parses the one-time verification token without requiring a signature', () => {
    expect(
      parseNotionWebhookVerification(JSON.stringify({ verification_token: verificationToken })),
    ).toEqual({
      _tag: 'NotionWebhookVerification',
      verificationToken,
    })

    expect(
      parseNotionWebhookRequest({
        rawBody: JSON.stringify({ verification_token: verificationToken }),
        headers: {},
      }),
    ).toEqual({
      _tag: 'NotionWebhookVerification',
      verificationToken,
    })
  })

  it('validates X-Notion-Signature over the exact raw body bytes', () => {
    const rawBody = JSON.stringify({
      id: 'event-1',
      type: 'page.properties_updated',
      entity: { id: 'page-1', type: 'page' },
    })
    const signatureHeader = computeNotionWebhookSignature({ rawBody, verificationToken })

    expect(
      verifyNotionWebhookSignature({
        rawBody,
        verificationToken,
        signatureHeader,
      }),
    ).toEqual({ _tag: 'valid' })

    expect(
      verifyNotionWebhookSignature({
        rawBody: `${rawBody}\n`,
        verificationToken,
        signatureHeader,
      }),
    ).toEqual({ _tag: 'invalid', reason: 'signature-mismatch' })
  })

  it('rejects missing malformed or mismatched signatures once a token exists', () => {
    const rawBody = JSON.stringify({
      id: 'event-1',
      type: 'page.created',
      entity: { id: 'page-1', type: 'page' },
    })

    expect(parseNotionWebhookRequest({ rawBody, headers: {}, verificationToken })).toEqual({
      _tag: 'NotionWebhookRejected',
      reason: 'missing-signature',
    })

    expect(
      parseNotionWebhookRequest({
        rawBody,
        headers: { 'X-Notion-Signature': 'not-a-signature' },
        verificationToken,
      }),
    ).toEqual({
      _tag: 'NotionWebhookRejected',
      reason: 'malformed-signature',
    })

    expect(
      parseNotionWebhookRequest({
        rawBody,
        headers: {
          'X-Notion-Signature': computeNotionWebhookSignature({
            rawBody,
            verificationToken: 'different-token',
          }),
        },
        verificationToken,
      }),
    ).toEqual({
      _tag: 'NotionWebhookRejected',
      reason: 'signature-mismatch',
    })
  })

  it('normalizes page and data-source events into provider-neutral invalidation signals', () => {
    const pageSignal = normalizeNotionWebhookPayload({
      id: 'event-page',
      type: 'page.properties_updated',
      timestamp: '2026-05-29T08:00:00.000Z',
      api_version: '2026-03-11',
      attempt_number: 2,
      subscription_id: 'sub-1',
      workspace_id: 'workspace-1',
      integration_id: 'integration-1',
      entity: { id: 'page-1', type: 'page' },
      data: { parent: { data_source_id: 'data-source-1' } },
    })

    expect(pageSignal).toMatchObject({
      _tag: 'NotionWebhookSignal',
      provider: 'notion',
      eventId: 'event-page',
      eventType: 'page.properties_updated',
      pageId: 'page-1',
      dataSourceId: 'data-source-1',
      attemptNumber: 2,
    })

    const dataSourceSignal = normalizeNotionWebhookPayload({
      id: 'event-data-source',
      type: 'data_source.schema_updated',
      entity: { id: 'data-source-1', type: 'data_source' },
    })

    expect(dataSourceSignal).toMatchObject({
      _tag: 'NotionWebhookSignal',
      eventId: 'event-data-source',
      eventType: 'data_source.schema_updated',
      dataSourceId: 'data-source-1',
    })
  })

  it('accepts future event types without keeping the raw payload in the normalized signal', () => {
    // Route through parseNotionWebhookRequest so the extra unknown field passes the
    // schema decoder (onExcessProperty:'preserve'), while the normalized signal must
    // not carry any raw payload material.
    const result = parseNotionWebhookRequest({
      rawBody: JSON.stringify({
        id: 'event-future',
        type: 'workspace.something_added_later',
        entity: { id: 'workspace-1', type: 'workspace' },
        raw_secret_like_field: 'do-not-carry-forward',
      }),
      headers: {},
    })

    expect(result._tag).toBe('NotionWebhookEvent')
    if (result._tag !== 'NotionWebhookEvent') return

    expect(result.signal).toMatchObject({
      _tag: 'NotionWebhookSignal',
      eventId: 'event-future',
      eventType: 'workspace.something_added_later',
      entity: { id: 'workspace-1', type: 'workspace' },
    })
    expect(JSON.stringify(result.signal)).not.toContain('do-not-carry-forward')
  })

  it('rejects a valid-HMAC request whose payload shape is malformed with invalid-payload-shape', () => {
    // Cross-product the existing bad-shape and valid-signature coverage: a body
    // that carries a CORRECT X-Notion-Signature but is missing the required
    // `type` field must still be rejected for shape — proving the shape decode
    // runs (and fails closed) AFTER signature verification passes, not only on
    // the unsigned path.
    const rawBody = JSON.stringify({ id: 'event-1', entity: { id: 'page-1', type: 'page' } })
    const signatureHeader = computeNotionWebhookSignature({ rawBody, verificationToken })

    // The signature itself is valid over these exact bytes...
    expect(verifyNotionWebhookSignature({ rawBody, verificationToken, signatureHeader })).toEqual({
      _tag: 'valid',
    })

    // ...yet the request is still rejected for its malformed shape.
    expect(
      parseNotionWebhookRequest({
        rawBody,
        headers: { 'X-Notion-Signature': signatureHeader },
        verificationToken,
      }),
    ).toEqual({
      _tag: 'NotionWebhookRejected',
      reason: 'invalid-payload-shape',
    })
  })

  it('rejects malformed JSON with invalid-json reason', () => {
    expect(parseNotionWebhookRequest({ rawBody: 'not-json', headers: {} })).toEqual({
      _tag: 'NotionWebhookRejected',
      reason: 'invalid-json',
    })
  })

  it('rejects a payload that is missing the required type field with invalid-payload-shape', () => {
    const result = parseNotionWebhookRequest({
      rawBody: JSON.stringify({ id: 'event-1' }),
      headers: {},
    })
    expect(result).toEqual({
      _tag: 'NotionWebhookRejected',
      reason: 'invalid-payload-shape',
    })
  })

  it('rejects a signature-mismatch request before any shape decode or store write', () => {
    const rawBody = JSON.stringify({ id: 'event-1', type: 'page.created' })
    const result = parseNotionWebhookRequest({
      rawBody,
      headers: { 'X-Notion-Signature': 'sha256=' + 'a'.repeat(64) },
      verificationToken,
    })
    expect(result).toEqual({ _tag: 'NotionWebhookRejected', reason: 'signature-mismatch' })
  })

  it('drops unknown nested entity fields so they do not reach the signal or store', () => {
    const result = parseNotionWebhookRequest({
      rawBody: JSON.stringify({
        id: 'event-entity-secret',
        type: 'page.created',
        entity: { id: 'page-1', type: 'page', secret_nested_field: 'do-not-carry' },
      }),
      headers: {},
    })

    expect(result._tag).toBe('NotionWebhookEvent')
    if (result._tag !== 'NotionWebhookEvent') return

    expect(result.signal.entity).toEqual({ id: 'page-1', type: 'page' })
    expect(JSON.stringify(result.signal)).not.toContain('do-not-carry')
  })
})
