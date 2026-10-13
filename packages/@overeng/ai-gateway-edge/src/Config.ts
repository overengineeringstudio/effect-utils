import { Effect, FileSystem, Schema } from 'effect'

const Consumer = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed())),
  tokenSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: 'AiGatewayEdge.Consumer' })

/** Runtime-only upstream, consumer verifiers and metric cardinality configuration. */
export const GatewayConfig = Schema.Struct({
  upstream: Schema.URLFromString,
  consumers: Schema.Array(Consumer),
  maxModelLabels: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: 'AiGatewayEdge.Config' })

/** Decoded runtime gateway configuration. */
export type GatewayConfig = typeof GatewayConfig.Type

/** Configuration read or schema-decode failure, retaining its original cause. */
export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()('ConfigLoadError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Read and decode runtime JSON configuration through Effect FileSystem. */
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
