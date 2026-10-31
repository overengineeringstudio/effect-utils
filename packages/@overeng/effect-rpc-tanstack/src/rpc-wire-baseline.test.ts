import { Effect, Exit, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { deserialize, serialize } from 'seroval'
import { describe, expect, it } from 'vitest'

import { encodeExit, decodeExit, makeEffectLoaderResult } from './router.ts'
import { makeHandler } from './server.ts'

class GreetingError extends Schema.TaggedError<GreetingError>()('GreetingError', {
  reason: Schema.Literals(['missing-user', 'blocked']),
  userId: Schema.String,
}) {}

const GetGreeting = Rpc.make('GetGreeting', {
  payload: {
    userId: Schema.String,
    note: Schema.NullOr(Schema.String),
  },
  success: Schema.Struct({
    message: Schema.String,
    empty: Schema.String,
    unicode: Schema.String,
  }),
  error: GreetingError,
})

const Api = RpcGroup.make(GetGreeting)

const encodeJsonBytes = (value: unknown): string => JSON.stringify(value, null, 2)

const jsonWireRoundTrip = (value: unknown) => {
  const encoded = encodeJsonBytes(value)
  const decoded = JSON.parse(encoded) as unknown
  const reencoded = encodeJsonBytes(decoded)

  return {
    encoded,
    decoded,
    reencoded,
    byteIdentical: reencoded === encoded,
  }
}

const requestBytes = (value: unknown): string => `${JSON.stringify(value)}\n`

const rpcPost = async ({
  handler,
  body,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly body: string
}) => {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
  })
  const response = await handler(request)

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  }
}

const decodeExitFailure = (encoded: unknown) => {
  try {
    return {
      _tag: 'decoded' as const,
      value: decodeExit(encoded as Parameters<typeof decodeExit>[0]),
    }
  } catch (error) {
    return {
      _tag: 'failed' as const,
      error: error instanceof Error ? String(error) : String(error),
    }
  }
}

describe('effect-rpc-tanstack RPC wire baselines (cross-major invariant)', () => {
  it.each([
    ['failure', Exit.fail({ _tag: 'ExpectedError', message: 'missing user' })],
    ['defect', Exit.die('loader defect')],
    ['interrupt', Exit.interrupt(123)],
  ])('encodes %s as plain JSON data and decodes it after transport', (_, exit) => {
    const assertPlainData = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return
      expect(Object.getPrototypeOf(value)).toBe(
        Array.isArray(value) === true ? Array.prototype : Object.prototype,
      )
      for (const child of Object.values(value)) assertPlainData(child)
    }
    const encoded = encodeExit(exit)
    assertPlainData(encoded)
    const transported = structuredClone(encoded)
    expect(decodeExit(transported)).toEqual(exit)
    expect(decodeExit(deserialize<typeof encoded>(serialize(encoded)))).toEqual(exit)
  })

  it('preserves seroval-native success payloads', () => {
    const value = { absent: undefined, date: new Date(0), entries: new Map([['key', 'value']]) }
    const encoded = encodeExit(Exit.succeed(value))
    expect(decodeExit(deserialize<typeof encoded>(serialize(encoded)))).toEqual(Exit.succeed(value))
  })

  it.each(['GetInvoicesData', 'UnknownRpc'])(
    'handles an NDJSON Request for %s without a trailing newline',
    async (tag) => {
      const group = RpcGroup.make(
        Rpc.make('GetInvoicesData', { payload: {}, success: Schema.String }),
      )
      const { handler, dispose } = makeHandler({
        group,
        handlerLayer: group.toLayer({ GetInvoicesData: () => Effect.succeed('invoices') }),
        disableTracing: true,
      })
      try {
        const request = new Request('http://localhost/api/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/x-ndjson' },
          body: JSON.stringify({ _tag: 'Request', id: '1', tag, payload: {}, headers: [] }),
        })
        const response = await handler(request)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/x-ndjson')
        const message = JSON.parse(await response.text())
        expect(request.signal.aborted).toBe(false)
        if (tag === 'GetInvoicesData') {
          expect(message).toEqual({
            _tag: 'Exit',
            requestId: '1',
            exit: { _tag: 'Success', value: 'invoices' },
          })
        } else {
          expect(message).toEqual({
            _tag: 'Exit',
            requestId: '1',
            exit: {
              _tag: 'Failure',
              cause: [{ _tag: 'Die', defect: 'Unknown request tag: UnknownRpc' }],
            },
          })
        }
      } finally {
        await dispose()
      }
    },
  )

  // These bytes pin the package's single current SSR Exit format. #979 records
  // consumer-owned coordinated rollout and cache policy; there is no dual decoder.
  // SSR uses plain Cause.reasons containers; HTTP RPC encodes causes as arrays.
  it('captures SSR Exit JSON bytes and re-encoded identity', () => {
    const exits = {
      success: encodeExit(
        Exit.succeed({
          message: 'hello ß',
          empty: '',
          nested: { absentIsOmitted: undefined, explicitNull: null },
        }),
      ),
      failure: encodeExit(Exit.fail(new GreetingError({ reason: 'missing-user', userId: '' }))),
      defect: encodeExit(Exit.die(new Error('loader defect ß'))),
    }
    for (const encoded of Object.values(exits)) {
      // Seroval materializes Error.name as an own property; payload fields survive.
      expect(decodeExit(deserialize<typeof encoded>(serialize(encoded)))).toMatchObject(
        decodeExit(encoded),
      )
    }

    const successResult = makeEffectLoaderResult<typeof exits.success, GreetingError>(exits.success)
    const failureResult = makeEffectLoaderResult<unknown, GreetingError>(exits.failure)
    const defectResult = makeEffectLoaderResult<unknown, unknown>(exits.defect)

    expect({
      wire: jsonWireRoundTrip(exits),
      decoded: {
        successGetOrThrow: successResult.getOrThrow(),
        failureError: failureResult.error,
        failureMatch: failureResult.match<unknown>({
          onSuccess: (value) => ({ _tag: 'success', value }),
          onFailure: (error) => ({ _tag: error._tag, reason: error.reason, userId: error.userId }),
        }),
        defectMatch: defectResult.match<unknown>({
          onSuccess: (value) => ({ _tag: 'success', value }),
          onFailure: (error) => ({ _tag: 'failure', error }),
          onDefect: (defect) => ({
            _tag: 'defect',
            message: defect instanceof Error ? defect.message : String(defect),
          }),
        }),
      },
      failures: {
        invalidExitTag: decodeExitFailure({ _tag: 'NotAnExit', value: null }),
        missingFailureCause: decodeExitFailure({ _tag: 'Failure' }),
      },
    }).toMatchSnapshot()
  })

  // These bytes pin the package's single current HTTP RPC format. #979 records
  // consumer-owned coordinated rollout and cache policy; there is no dual decoder.
  // Effect 4.1 uses application/x-ndjson; the RPC message bodies remain unchanged.
  it('captures HTTP RPC NDJSON bytes and failure partition', async () => {
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          GetGreeting: ({ userId, note }) =>
            userId === ''
              ? Effect.fail(new GreetingError({ reason: 'missing-user', userId }))
              : Effect.succeed({
                  message: `hello ${userId}`,
                  empty: note ?? '',
                  unicode: 'Grüße ß',
                }),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
      disableTracing: true,
    })

    const requests = {
      success: requestBytes({
        _tag: 'Request',
        id: '1',
        tag: 'GetGreeting',
        payload: { userId: 'ada-ß', note: null },
        headers: [],
      }),
      domainFailure: requestBytes({
        _tag: 'Request',
        id: '2',
        tag: 'GetGreeting',
        payload: { userId: '', note: '' },
        headers: [],
      }),
      invalidPayload: requestBytes({
        _tag: 'Request',
        id: '3',
        tag: 'GetGreeting',
        payload: { userId: 123, note: undefined },
        headers: [],
      }),
      unknownTag: requestBytes({
        _tag: 'Request',
        id: '4',
        tag: 'UnknownRpc',
        payload: {},
        headers: [],
      }),
      invalidEnvelope: `${JSON.stringify({ _tag: 'Request', id: '5' })}\n`,
      invalidId: requestBytes({
        _tag: 'Request',
        id: 'req-invalid-id',
        tag: 'GetGreeting',
        payload: { userId: 'ada-ß', note: null },
        headers: [],
      }),
    }

    try {
      const responses = {
        success: await rpcPost({ handler, body: requests.success }),
        domainFailure: await rpcPost({ handler, body: requests.domainFailure }),
        invalidPayload: await rpcPost({ handler, body: requests.invalidPayload }),
        unknownTag: await rpcPost({ handler, body: requests.unknownTag }),
        invalidEnvelope: await rpcPost({ handler, body: requests.invalidEnvelope }),
        invalidId: await rpcPost({ handler, body: requests.invalidId }),
      }

      expect({
        requests,
        responses,
        requestWire: jsonWireRoundTrip(requests),
        responseWire: jsonWireRoundTrip(responses),
      }).toMatchSnapshot()
    } finally {
      await dispose()
    }
  })
})
