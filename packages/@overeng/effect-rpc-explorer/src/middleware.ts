import { Cause, Effect, Option, Result } from 'effect'
import { RpcSchema } from 'effect/unstable/rpc'
import type { RpcMiddleware } from 'effect/unstable/rpc'

import type { CaptureChannel } from './model.ts'
import { makeProtocolObserver } from './protocol.ts'
import type { ProtocolObserverOptions } from './protocol.ts'

/**
 * Observes decoded server payloads and the handler terminal Cause. Pair with a
 * server protocol decorator using the same store; their shared coordinator
 * keeps each request and terminal milestone single-shot.
 */
export const makeServerExplorerMiddleware = (
  options: ProtocolObserverOptions,
): RpcMiddleware.RpcMiddleware<never, never, never> => {
  const observer = makeProtocolObserver(options, 'server')

  // oxlint-disable-next-line overeng/named-args -- RpcMiddleware has a fixed positional callback signature.
  return (effect, metadata) => {
    const identity = observer.decodedRequest({
      clientId: metadata.client.id,
      requestId: metadata.requestId,
      tag: metadata.rpc._tag,
      payload: metadata.payload,
      headers: metadata.headers,
    })
    const isStream = RpcSchema.isStreamSchema(metadata.rpc.successSchema)

    return Effect.onExit(effect, (exit) =>
      Effect.sync(() => {
        if (exit._tag === 'Success') {
          observer.terminalValue({
            identity,
            outcome: 'success',
            values: isStream === true ? [] : [{ channel: 'success', value: exit.value }],
          })
          return
        }

        if (Cause.hasDies(exit.cause) === true) {
          const defect = Cause.findDefect(exit.cause)
          observer.terminalValue({
            identity,
            outcome: 'defect',
            values:
              Result.isSuccess(defect) === true
                ? [{ channel: 'defect', value: defect.success }]
                : [],
          })
          return
        }

        if (Cause.hasInterrupts(exit.cause) === true) {
          observer.terminalValue({ identity, outcome: 'interrupted', values: [] })
          return
        }

        const failure = Cause.findErrorOption(exit.cause)
        const channel: CaptureChannel = isStream === true ? 'streamError' : 'typedFailure'
        observer.terminalValue({
          identity,
          outcome: 'typedFailure',
          values: Option.isSome(failure) === true ? [{ channel, value: failure.value }] : [],
        })
      }),
    )
  }
}
