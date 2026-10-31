import { Context, Effect, Layer, Schema, Stream } from 'effect'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { ActionsError } from './ActionsCommon.ts'

/** Concrete field identity and the reason shown by the secret approval boundary. */
export interface SecretHandle {
  readonly ref: `op://${string}/${string}/${string}`
  readonly reason: string
}

/** Injectable byte reader; callers zero returned buffers and must not retain secret values. */
export class SecretSource extends Context.Service<
  SecretSource,
  {
    /** The caller owns the returned bytes and must zero them after use. */
    readonly read: (handle: SecretHandle) => Effect.Effect<Uint8Array, ActionsError>
  }
>()('@overeng/alchemy-github/SecretSource') {}

const failure = (message: string) => new ActionsError({ operation: 'read secret', message })
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))

/** Requires a runtime ChildProcessSpawner; never persists or logs secret material. */
export const SecretSourceLive = Layer.effect(
  SecretSource,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return SecretSource.of({
      read: Effect.fn('SecretSource.read')(function* (handle: SecretHandle) {
        const ref =
          typeof handle.ref === 'string'
            ? /^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/([^\p{Cc}/]+)$/iu.exec(handle.ref)
            : null
        if (
          ref === null ||
          ref[1]!.trim().length === 0 ||
          typeof handle.reason !== 'string' ||
          handle.reason.trim().length === 0 ||
          handle.reason.includes('\0') === true
        ) {
          return yield* failure(
            'A concrete vault/item field reference and a nonempty reason are required',
          )
        }
        const buffer = new Uint8Array(512 * 1024)
        let length = 0
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                'op-proxy',
                [
                  'read',
                  handle.ref,
                  '--reason',
                  handle.reason,
                  '--cache',
                  'none',
                  '--fresh',
                  '--output',
                  'json',
                ],
                { stdin: 'ignore', stderr: 'ignore' },
              ),
            )
            const [, code] = yield* Effect.all(
              [
                Stream.runForEach(child.stdout, (chunk) => {
                  if (length + chunk.length > buffer.length) {
                    chunk.fill(0)
                    return Effect.fail(failure('Secret output exceeded its size limit'))
                  }
                  buffer.set(chunk, length)
                  length += chunk.length
                  chunk.fill(0)
                  return Effect.void
                }),
                child.exitCode,
              ],
              { concurrency: 'unbounded' },
            )
            if (code !== 0) return yield* failure('op-proxy secret read failed')
            // JSON is a scalar string. The installed CLI itself trims the original value;
            // do not trim again here or mistake its output framing for secret bytes.
            return yield* Effect.try({
              try: () =>
                new TextEncoder().encode(
                  decode(
                    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
                  ),
                ),
              catch: () => failure('op-proxy returned invalid secret output'),
            })
          }),
        ).pipe(
          Effect.mapError(() => failure('Unable to read secret through op-proxy')),
          Effect.ensuring(Effect.sync(() => buffer.fill(0))),
        )
      }),
    })
  }),
)
