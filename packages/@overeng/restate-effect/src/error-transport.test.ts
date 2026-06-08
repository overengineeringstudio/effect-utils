/**
 * Server-free contract-layer test of the error-transport round-trip (spec §5,
 * §11.3): a domain `Schema.TaggedError` → `toTerminal` (per-error errorCode,
 * `_tag` in the message body) → a simulated ingress `HttpCallError` → the
 * `decodeTerminalError` helper → back to the typed tagged error, so a caller
 * `catchTag`s it. No native server involved.
 */
import * as restate from '@restatedev/restate-sdk'
import * as clients from '@restatedev/restate-sdk-clients'
import { Cause, Effect, Exit, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { Restate } from './Annotations.ts'
import { decodeTerminalError } from './Client.ts'
import { toTerminal } from './Endpoint.ts'
import { RestateError } from './RestateError.ts'
import { RestateService } from './Service.ts'

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
})
