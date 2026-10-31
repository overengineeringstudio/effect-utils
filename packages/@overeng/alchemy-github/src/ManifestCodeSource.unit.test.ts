import { it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect'
import { expect } from 'vitest'

import { AppError } from './AppErrors.ts'
import { fromEnv, fromPrompt, ManifestCodeSource } from './ManifestCodeSource.ts'

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

for (const state of ['pending-token', 'wrong-token', undefined]) {
  it.effect(`binds environment callback to pending state: ${state ?? 'missing'}`, () =>
    Effect.gen(function* () {
      const source = yield* ManifestCodeSource
      const result = yield* source.read('pending-token').pipe(Effect.result)
      if (state === 'pending-token') {
        expect(result._tag).toBe('Success')
        if (result._tag === 'Success')
          expect(Redacted.value(result.success)).toBe('callback-sentinel')
      } else {
        expect(result._tag).toBe('Failure')
      }
      expect(encode(result)).not.toContain('callback-sentinel')
    }).pipe(
      Effect.provide(
        Layer.merge(
          fromEnv('CALLBACK'),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CALLBACK: 'callback-sentinel',
              ...(state === undefined ? {} : { CALLBACK_STATE: state }),
            }),
          ),
        ),
      ),
    ),
  )
}

it.effect('rejects mismatched prompt callbacks and sanitizes source failures', () =>
  Effect.gen(function* () {
    for (const layer of [
      fromPrompt(() =>
        Effect.succeed({ state: 'wrong', code: Redacted.make('callback-sentinel') }),
      ),
      fromPrompt(() =>
        Effect.fail(new AppError({ operation: 'prompt', message: 'callback-sentinel' })),
      ),
    ]) {
      const error = yield* Effect.gen(function* () {
        const source = yield* ManifestCodeSource
        return yield* source.read('pending-token')
      }).pipe(Effect.provide(layer), Effect.flip)
      expect(error._tag).toBe('GitHubAppResourceError')
      expect(encode(error)).not.toContain('callback-sentinel')
    }
  }),
)
