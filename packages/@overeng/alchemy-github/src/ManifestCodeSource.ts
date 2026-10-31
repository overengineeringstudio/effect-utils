import { Config, Context, Effect, Layer, Redacted } from 'effect'

import { AppError } from './AppErrors.ts'

/** Ephemeral callback response; never pass this value into resource props or outputs. */
export interface ManifestCallback {
  readonly state: string
  readonly code: Redacted.Redacted<string>
}

/** Resolve a callback only during apply, bound to the persisted pending registration token. */
export class ManifestCodeSource extends Context.Service<
  ManifestCodeSource,
  { readonly read: (pendingState: string) => Effect.Effect<Redacted.Redacted<string>, AppError> }
>()('GitHub.ManifestCodeSource') {}

/** Provider injection contract for apply-time callback acquisition. */
export type ManifestCodeSourceLayer = Layer.Layer<ManifestCodeSource>

const bound = Effect.fn('GitHub.ManifestCodeSource.bound')(function* (
  pendingState: string,
  callback: ManifestCallback,
) {
  if (callback.state !== pendingState || Redacted.value(callback.code).length === 0)
    return yield* new AppError({
      operation: 'manifest code source',
      message: 'Manifest callback is empty or belongs to another pending registration.',
    })
  return callback.code
})

/** Read CODE and CODE_STATE environment variables at apply time, never while planning. */
export const fromEnv = (name = 'GITHUB_APP_MANIFEST_CODE') =>
  Layer.succeed(ManifestCodeSource, {
    read: (pendingState) =>
      Effect.gen(function* () {
        const code = yield* Config.Redacted(name)
        const state = yield* Config.String(`${name}_STATE`)
        return yield* bound(pendingState, { code, state })
      }).pipe(
        Effect.catchCause(() =>
          Effect.fail(
            new AppError({
              operation: 'manifest code source',
              message:
                'Manifest callback environment is unavailable or does not match pending state.',
            }),
          ),
        ),
      ),
  })

/** Inject an interactive prompt implementation; it must return the callback state as well as code. */
export const fromPrompt = (
  prompt: (pendingState: string) => Effect.Effect<ManifestCallback, AppError>,
) =>
  Layer.succeed(ManifestCodeSource, {
    read: (pendingState) =>
      Effect.suspend(() => prompt(pendingState)).pipe(
        Effect.flatMap((callback) => bound(pendingState, callback)),
        Effect.catchCause(() =>
          Effect.fail(
            new AppError({
              operation: 'manifest code source',
              message: 'Manifest callback prompt failed or did not match pending state.',
            }),
          ),
        ),
      ),
  })
