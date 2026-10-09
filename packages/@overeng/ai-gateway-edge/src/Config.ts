import { Effect, FileSystem, Schema } from 'effect'

const Consumer = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed())),
  tokenSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: 'AiGatewayEdge.Consumer' })

export const GatewayConfig = Schema.Struct({
  upstream: Schema.URLFromString,
  consumers: Schema.Array(Consumer),
}).annotate({ identifier: 'AiGatewayEdge.Config' })

export type GatewayConfig = typeof GatewayConfig.Type

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()('ConfigLoadError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const loadConfig = Effect.fn('ai-gateway-edge.loadConfig')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new ConfigLoadError({ message: `Cannot read config ${path}`, cause }),
      ),
    )
  return yield* Schema.decodeEffect(Schema.fromJsonString(GatewayConfig))(text).pipe(
    Effect.mapError((cause) => new ConfigLoadError({ message: `Invalid config ${path}`, cause })),
  )
})
