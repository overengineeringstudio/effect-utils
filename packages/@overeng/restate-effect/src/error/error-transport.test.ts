/**
 * Server-free contract-layer test of the error-transport round-trip (docs/vrs/04-error-boundary/spec.md §1,
 * docs/vrs/09-testing/spec.md §3): a domain `Schema.TaggedError` → `toTerminal` (per-error errorCode,
 * `_tag` in the message body) → a simulated ingress `HttpCallError` → the
 * `decodeTerminalError` helper → back to the typed tagged error, so a caller
 * `catchTag`s it. No native server involved.
 */
import * as restate from '@restatedev/restate-sdk'
import * as clients from '@restatedev/restate-sdk-clients'
import { Cause, Effect, Exit, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { RestateService } from '../authoring/Service.ts'
import { decodeTerminalError } from '../clients/Client.ts'
import { Restate } from '../schema/Annotations.ts'
import { RestateError } from '../schema/RestateError.ts'
import { toTerminal } from './Boundary.ts'

/* A domain error annotated terminal with a custom errorCode (404). */
class NotFound extends Schema.TaggedError<NotFound>('test/NotFound')('NotFound', {
  id: Schema.String,
}) {}
const NotFoundSchema = Restate.terminal(Schema.asSchema(NotFound), { errorCode: 404 })

const LookupInput = Schema.Struct({ id: Schema.String })
const LookupSuccess = Schema.Struct({ value: Schema.String })
const Registry = RestateService.contract('registry', {
  lookup: { input: LookupInput, success: LookupSuccess, error: NotFoundSchema },
})

/**
 * Simulate the transport: `toTerminal` body → the ingress envelope
 * (`{ code, message, metadata }`, the shape the real `restate-server` returns in
 * `responseText`) → an ingress `HttpCallError`. The decode helper must unwrap
 * the envelope's `message` (the JSON-encoded `toTerminal` body) before decoding.
 */
const simulateIngressFailure = (error: NotFound): RestateError => {
  const terminal = toTerminal(Cause.fail(error), NotFoundSchema)
  if (!(terminal instanceof restate.TerminalError)) {
    throw new Error('expected toTerminal to yield a TerminalError')
  }
  const envelope = JSON.stringify({
    code: terminal.code,
    message: terminal.message,
    metadata: terminal.metadata,
  })
  const httpErr = new clients.HttpCallError(
    terminal.code,
    envelope,
    `Request failed: ${terminal.code}`,
  )
  return new RestateError({
    reason: 'IngressFailed',
    method: 'call(registry.lookup)',
    cause: httpErr,
  })
}

describe('error transport (contract layer, server-free)', () => {
  it('toTerminal encodes the _tag + fields in the body with the per-error errorCode', () => {
    const terminal = toTerminal(Cause.fail(new NotFound({ id: 'x_1' })), NotFoundSchema)
    expect(terminal).toBeInstanceOf(restate.TerminalError)
    const t = terminal as restate.TerminalError
    expect(t.code).toBe(404)
    const body = JSON.parse(t.message) as { _tag: string; id: string }
    expect(body._tag).toBe('NotFound')
    expect(body.id).toBe('x_1')
    expect(t.metadata?.['_tag']).toBe('NotFound')
  })

  it('decodeTerminalError recovers the typed tagged error so catchTag handles it', async () => {
    const failing = Effect.fail(simulateIngressFailure(new NotFound({ id: 'x_2' })))
    const recovered = await Effect.runPromise(
      failing.pipe(
        decodeTerminalError(Registry, 'lookup'),
        Effect.map(() => 'unexpected' as const),
        Effect.catchTag('NotFound', (e) => Effect.succeed(`recovered:${e.id}` as const)),
      ),
    )
    expect(recovered).toBe('recovered:x_2')
  })

  it('keeps the raw RestateError when the body does not match the error schema', async () => {
    const unrelated = new RestateError({
      reason: 'IngressFailed',
      method: 'call(registry.lookup)',
      cause: new clients.HttpCallError(500, '{"_tag":"Other"}', '{"_tag":"Other"}'),
    })
    const exit = await Effect.runPromiseExit(
      Effect.fail(unrelated).pipe(decodeTerminalError(Registry, 'lookup')),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe('Some')
      if (failure._tag === 'Some') expect(failure.value).toBeInstanceOf(RestateError)
    }
  })

  it('a retryable-annotated error throws RetryableError instead of terminalizing', () => {
    class Throttled extends Schema.TaggedError<Throttled>('test/Throttled')('Throttled', {}) {}
    const ThrottledSchema = Restate.retryable(Schema.asSchema(Throttled))
    const out = toTerminal(Cause.fail(new Throttled()), ThrottledSchema)
    expect(out).toBeInstanceOf(restate.RetryableError)
    expect(out).not.toBeInstanceOf(restate.TerminalError)
  })

  it('retryAfter is projected from the ACTUAL error instance (#3)', () => {
    /* A 429-style error carrying its own retry floor; the projection reads it off
     * the very instance that failed, not a static literal. */
    class RateLimited extends Schema.TaggedError<RateLimited>('test/RateLimited')('RateLimited', {
      retryAfterMillis: Schema.Number,
    }) {}
    const RateLimitedSchema = Restate.retryable(Schema.asSchema(RateLimited), {
      retryAfter: (e) => e.retryAfterMillis,
    })
    const out = toTerminal(
      Cause.fail(new RateLimited({ retryAfterMillis: 7_500 })),
      RateLimitedSchema,
    )
    expect(out).toBeInstanceOf(restate.RetryableError)
    expect((out as restate.RetryableError).retryAfter).toBe(7_500)
  })

  it('retryAfter accepts a static Duration shorthand', () => {
    class Slow extends Schema.TaggedError<Slow>('test/Slow')('Slow', {}) {}
    const SlowSchema = Restate.retryable(Schema.asSchema(Slow), { retryAfter: '2 seconds' })
    const out = toTerminal(Cause.fail(new Slow()), SlowSchema)
    expect((out as restate.RetryableError).retryAfter).toBe(2_000)
  })

  it('a projection returning undefined falls back to default backoff (no floor)', () => {
    class Maybe extends Schema.TaggedError<Maybe>('test/Maybe')('Maybe', {
      after: Schema.optional(Schema.Number),
    }) {}
    const MaybeSchema = Restate.retryable(Schema.asSchema(Maybe), { retryAfter: (e) => e.after })
    const out = toTerminal(Cause.fail(new Maybe({})), MaybeSchema)
    expect(out).toBeInstanceOf(restate.RetryableError)
    expect((out as restate.RetryableError).retryAfter).toBeUndefined()
  })

  it('a union error schema classifies per-MEMBER (retryable member ≠ terminal member)', () => {
    /* The declared error is a `Schema.Union` of a RETRYABLE 429 + a TERMINAL 404.
     * The per-member `terminal`/`retryable` annotation lives on the MEMBERS, not the
     * union node, so the boundary must resolve the matching member for the actual
     * failing error before reading the class — else the retryable member is silently
     * mis-classified as terminal (the pollLoop compose blocker). */
    class RateLimited extends Schema.TaggedError<RateLimited>('test/RateLimited2')('RateLimited', {
      retryAfterMillis: Schema.Number,
    }) {}
    class Gone extends Schema.TaggedError<Gone>('test/Gone')('Gone', { id: Schema.String }) {}
    const UnionSchema = Schema.Union(
      Restate.retryable(Schema.asSchema(RateLimited), { retryAfter: (e) => e.retryAfterMillis }),
      Restate.terminal(Schema.asSchema(Gone), { errorCode: 404 }),
    )

    /* The RETRYABLE member → a RetryableError honoring its projected retryAfter. */
    const retry = toTerminal(Cause.fail(new RateLimited({ retryAfterMillis: 1_200 })), UnionSchema)
    expect(retry).toBeInstanceOf(restate.RetryableError)
    expect(retry).not.toBeInstanceOf(restate.TerminalError)
    expect((retry as restate.RetryableError).retryAfter).toBe(1_200)

    /* The TERMINAL member → a TerminalError with its per-member errorCode (404). */
    const terminal = toTerminal(Cause.fail(new Gone({ id: 'g_1' })), UnionSchema)
    expect(terminal).toBeInstanceOf(restate.TerminalError)
    const t = terminal as restate.TerminalError
    expect(t.code).toBe(404)
    expect((JSON.parse(t.message) as { _tag: string })._tag).toBe('Gone')
  })

  it('a failure NOT matching the declared error union is a DEFECT, not a mis-encode', () => {
    /* `Registry.lookup` declares `NotFound`; a foreign tagged error must not be
     * silently encoded into a terminal body — it is error-classification drift and
     * surfaces as a defect (the squashed cause) so the SDK retries / the bug shows. */
    class Foreign extends Schema.TaggedError<Foreign>('test/Foreign')('Foreign', {
      whatever: Schema.String,
    }) {}
    const out = toTerminal(Cause.fail(new Foreign({ whatever: 'x' })), NotFoundSchema)
    expect(out).not.toBeInstanceOf(restate.TerminalError)
    expect(out).toBeInstanceOf(Foreign)
  })
})
