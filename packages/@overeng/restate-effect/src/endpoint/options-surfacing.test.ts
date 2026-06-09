import type * as restate from '@restatedev/restate-sdk'
import { Context, Effect, Runtime, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { run as durableRun } from '../authoring/RestateContext.ts'
import { RestateContext } from '../authoring/RestateContext.ts'
import { RestateService } from '../authoring/Service.ts'
import { Restate } from '../schema/Annotations.ts'
import { aesGcmCipher, RestateRedaction } from '../schema/Redaction.ts'
import { materialize } from './Endpoint.ts'

/* The SDK stashes a `HandlerWrapper` (carrying the resolved `options` bag) under a
 * module-private `Symbol("Handler")` on each transposed handler function. Read it
 * back so a server-free unit test can assert the SDK options `materialize`
 * produced. */
const handlerOptionsOf = (def: unknown, name: string): Record<string, unknown> | undefined => {
  const service = (def as { service: Record<string, unknown> }).service
  const fn = service[name] as object
  const sym = Object.getOwnPropertySymbols(fn).find((s) => s.toString() === 'Symbol(Handler)')
  if (sym === undefined) return undefined
  const wrapper = (fn as Record<symbol, unknown>)[sym] as { options?: Record<string, unknown> }
  return wrapper.options
}

const serviceOptionsOf = (def: unknown): Record<string, unknown> | undefined =>
  (def as { options?: Record<string, unknown> }).options

const Greet = Schema.Struct({ name: Schema.String })

describe('retention annotation → SDK retention options', () => {
  it('maps a Restate.retention annotation on the handler input to SDK retention millis', () => {
    /* `Duration.DurationInput` accepts the `"5 minutes"` etc. string form. */
    const input = Restate.retention(Greet, { idempotency: '5 minutes', journal: '1 hour' })
    const impl = RestateService.define(
      'Retained',
      { greet: { input, success: Schema.String } },
      { greet: () => Effect.succeed('hi') },
    )
    const def = materialize(impl, Runtime.defaultRuntime)
    const opts = handlerOptionsOf(def, 'greet')
    expect(opts?.idempotencyRetention).toBe(5 * 60 * 1000)
    expect(opts?.journalRetention).toBe(60 * 60 * 1000)
  })

  it('lets explicit builder options win over the annotation', () => {
    const input = Restate.retention(Greet, { journal: '1 hour' })
    const impl = RestateService.define(
      'Override',
      {
        greet: { input, success: Schema.String, options: { journalRetentionMillis: 42 } },
      },
      { greet: () => Effect.succeed('hi') },
    )
    const opts = handlerOptionsOf(materialize(impl, Runtime.defaultRuntime), 'greet')
    expect(opts?.journalRetention).toBe(42)
  })
})

describe('retry surfacing → SDK RetryPolicy', () => {
  it('maps a typed retryPolicy + timeouts on a handler to the SDK options', () => {
    const impl = RestateService.define(
      'Retried',
      {
        greet: {
          input: Greet,
          success: Schema.String,
          options: {
            retryPolicy: {
              maxAttempts: 5,
              initialIntervalMillis: 100,
              maxIntervalMillis: 5000,
              exponentiationFactor: 3,
              onMaxAttempts: 'pause',
            },
            inactivityTimeoutMillis: 30_000,
            ingressPrivate: true,
          },
        },
      },
      { greet: () => Effect.succeed('hi') },
    )
    const opts = handlerOptionsOf(materialize(impl, Runtime.defaultRuntime), 'greet')
    expect(opts?.retryPolicy).toStrictEqual({
      maxAttempts: 5,
      initialInterval: 100,
      maxInterval: 5000,
      exponentiationFactor: 3,
      onMaxAttempts: 'pause',
    })
    expect(opts?.inactivityTimeout).toBe(30_000)
    expect(opts?.ingressPrivate).toBe(true)
  })

  it('maps an asTerminalError hook through to the SDK options', () => {
    const asTerminalError = (): undefined => undefined
    const impl = RestateService.define(
      'Mapped',
      { greet: { input: Greet, success: Schema.String, options: { asTerminalError } } },
      { greet: () => Effect.succeed('hi') },
    )
    const opts = handlerOptionsOf(materialize(impl, Runtime.defaultRuntime), 'greet')
    expect(opts?.asTerminalError).toBe(asTerminalError)
  })

  it('maps a service-level retryPolicy to the definition options', () => {
    /* Service-level options live on the contract (third builder arg). */
    const contract = RestateService.contract(
      'ServiceRetry',
      { greet: { input: Greet, success: Schema.String } },
      { retryPolicy: { maxAttempts: 2, onMaxAttempts: 'kill' }, journalRetentionMillis: 9000 },
    )
    const bound = RestateService.implement(contract, { greet: () => Effect.succeed('hi') })
    const def = materialize(bound, Runtime.defaultRuntime)
    expect(serviceOptionsOf(def)).toMatchObject({
      retryPolicy: { maxAttempts: 2, onMaxAttempts: 'kill' },
      journalRetention: 9000,
    })
  })
})

describe('Restate.run RunOptions → SDK ctx.run options', () => {
  it('threads per-step retry options into ctx.run(name, action, options)', async () => {
    let captured: Record<string, unknown> | undefined
    /* A minimal fake context recording the `ctx.run` options bag. */
    const fakeCtx = {
      run: (_name: string, action: () => Promise<unknown>, options?: Record<string, unknown>) => {
        captured = options
        return action()
      },
    } as unknown as restate.Context

    const program = durableRun('step', Effect.succeed(123), {
      maxRetryAttempts: 4,
      maxRetryDurationMillis: 60_000,
      initialRetryIntervalMillis: 50,
      maxRetryIntervalMillis: 10_000,
      retryIntervalFactor: 2,
    }).pipe(Effect.provideService(RestateContext, fakeCtx))

    const result = await Effect.runPromise(program)
    expect(result).toBe(123)
    expect(captured).toStrictEqual({
      maxRetryAttempts: 4,
      maxRetryDuration: 60_000,
      initialRetryInterval: 50,
      maxRetryInterval: 10_000,
      retryIntervalFactor: 2,
    })
  })

  it('omits the options arg entirely when no RunOptions are given', async () => {
    let argc = -1
    const fakeCtx = {
      run: (...args: unknown[]) => {
        argc = args.length
        return (args[1] as () => Promise<unknown>)()
      },
    } as unknown as restate.Context
    await Effect.runPromise(
      durableRun('step', Effect.succeed(1)).pipe(Effect.provideService(RestateContext, fakeCtx)),
    )
    expect(argc).toBe(2)
  })
})

describe('redaction cipher resolution at materialize', () => {
  it('threads a RestateRedaction cipher from the runtime context into the handler serdes', () => {
    const Secret = Schema.Struct({ pin: Restate.sensitive(Schema.String) })
    const impl = RestateService.define(
      'Vault',
      { store: { input: Secret, success: Schema.String } },
      { store: () => Effect.succeed('ok') },
    )
    /* In production the cipher lives in the application `Layer` (so the served
     * runtime's context carries it); `materialize` resolves it best-effort via
     * `Context.getOption`, decoupled from the handler `AppR`. Mirror that here by
     * widening the cipher-carrying runtime back to `Runtime<never>`. */
    const runtime = Runtime.defaultRuntime.pipe(
      Runtime.updateContext(
        Context.add(RestateRedaction, aesGcmCipher(new Uint8Array(32).fill(7))),
      ),
    ) as Runtime.Runtime<never>
    const opts = handlerOptionsOf(materialize(impl, runtime), 'store')
    const inputSerde = opts?.input as { serialize: (v: unknown) => Uint8Array }
    const wire = JSON.parse(new TextDecoder().decode(inputSerde.serialize({ pin: '1234' }))) as {
      pin: string
    }
    /* The annotated field is ciphertext on the wire — the cipher reached the serde. */
    expect(wire.pin).not.toBe('1234')
  })
})

describe('materialize REJECTS misplaced field annotations (decision 0020)', () => {
  it('rejects Restate.idempotencyKey applied to the input STRUCT (wrong AST node)', () => {
    const impl = RestateService.define(
      'BadIdemStruct',
      {
        go: {
          input: Restate.idempotencyKey(Schema.Struct({ k: Schema.String })),
          success: Schema.Void,
        },
      },
      { go: () => Effect.void },
    )
    expect(() => materialize(impl, Runtime.defaultRuntime)).toThrow(/idempotencyKey.*STRUCT/s)
  })

  it('rejects Restate.sensitive applied to the input STRUCT (wrong AST node)', () => {
    const impl = RestateService.define(
      'BadSensitiveStruct',
      {
        go: { input: Restate.sensitive(Schema.Struct({ k: Schema.String })), success: Schema.Void },
      },
      { go: () => Effect.void },
    )
    expect(() => materialize(impl, Runtime.defaultRuntime)).toThrow(/sensitive.*STRUCT/s)
  })

  it('rejects DUPLICATE idempotency-key fields (ambiguous single source)', () => {
    const impl = RestateService.define(
      'DupIdem',
      {
        go: {
          input: Schema.Struct({
            a: Restate.idempotencyKey(Schema.String),
            b: Restate.idempotencyKey(Schema.String),
          }),
          success: Schema.Void,
        },
      },
      { go: () => Effect.void },
    )
    expect(() => materialize(impl, Runtime.defaultRuntime)).toThrow(
      /idempotencyKey.*SINGLE source/s,
    )
  })

  it('a correctly-placed field annotation materializes cleanly', () => {
    const impl = RestateService.define(
      'GoodPlacement',
      {
        go: {
          input: Schema.Struct({ k: Restate.idempotencyKey(Schema.String) }),
          success: Schema.Void,
        },
      },
      { go: () => Effect.void },
    )
    expect(() => materialize(impl, Runtime.defaultRuntime)).not.toThrow()
  })
})
