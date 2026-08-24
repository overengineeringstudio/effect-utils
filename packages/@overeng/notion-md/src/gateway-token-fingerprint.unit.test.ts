import { Cause, Effect, Exit, Layer, Redacted } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'

import { NotionConfig, notionTokenFingerprint } from '@overeng/notion-effect-client'

import { NmdGatewayError } from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import { NotionMdGateway } from './model.ts'

/* Known non-secret token; the fingerprint is a hash so no bytes leak. */
const token = Redacted.make('ntn_TESTONLYtoken')
const expectedFp = notionTokenFingerprint(token)

/* HttpClient that always answers 404, forcing every gateway op to fail. */
const failingHttpClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({ object: 'error', status: 404, code: 'object_not_found', message: 'nope' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    ),
  ),
)

const testLayer = NotionMdGatewayLive.pipe(
  Layer.provide(Layer.succeed(NotionConfig, { authToken: token, retryEnabled: false })),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, failingHttpClient)),
)

describe('NmdGatewayError token fingerprint', () => {
  it('carries the integration token fingerprint in both message and field', async () => {
    const exit = await Effect.gen(function* () {
      const gateway = yield* NotionMdGateway
      return yield* gateway.pullPage({ pageId: 'made-up-page-id' })
    }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === false) return
    const fail = Cause.findFail(exit.cause)
    const error = fail._tag === 'Success' ? fail.success.error : undefined
    expect(error).toBeInstanceOf(NmdGatewayError)
    if (error instanceof NmdGatewayError === false) return

    expect(error.token_fingerprint).toBe(expectedFp)
    expect(error.message).toContain(`[integration token ${expectedFp}]`)
    /* Fingerprint is a hash: no secret token bytes appear in the surfaced error. */
    expect(error.message).not.toContain('TESTONLYtoken')
    expect(expectedFp).toMatch(/^ntn_…#[0-9a-f]{8}$/u)
  })
})
