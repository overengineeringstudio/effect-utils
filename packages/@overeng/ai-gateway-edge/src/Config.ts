import { Effect, FileSystem, Redacted, Schema } from 'effect'

const Consumer = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed())),
  tokenSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: 'AiGatewayEdge.Consumer' })

/** Runtime-only upstream, consumer verifiers and request/metric bounds. */
export const GatewayConfig = Schema.Struct({
  upstream: Schema.URLFromString,
  upstreamTokenFile: Schema.optionalKey(Schema.NonEmptyString),
  consumers: Schema.Array(Consumer),
  maxModelLabels: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxRequestBodyBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  routeMaxRequestBodyBytes: Schema.optionalKey(
    Schema.Struct({
      '/v1/responses': Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
}).annotate({ identifier: 'AiGatewayEdge.Config' })

/** Decoded runtime gateway configuration. */
export type GatewayConfig = typeof GatewayConfig.Type & {
  readonly upstreamToken?: Redacted.Redacted<string>
}

/** Configuration read or schema-decode failure, retaining its original cause. */
export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()('ConfigLoadError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Token-file failures deliberately omit the filesystem cause and secret contents. */
export class UpstreamTokenLoadError extends Schema.TaggedError<UpstreamTokenLoadError>()(
  'UpstreamTokenLoadError',
  { message: Schema.String },
) {}

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
  const config: GatewayConfig = yield* Schema.decodeEffect(Schema.fromJsonString(GatewayConfig))(
    text,
  ).pipe(
    Effect.mapError((cause) => new ConfigLoadError({ message: `Invalid config ${path}`, cause })),
  )
  if (config.upstreamTokenFile === undefined) return config
  const tokenText = yield* fs
    .readFileString(config.upstreamTokenFile)
    .pipe(
      Effect.mapError(
        () => new UpstreamTokenLoadError({ message: 'Cannot read upstream token file' }),
      ),
    )
  const token = tokenText.replace(/\r?\n$/, '')
  if (token.length === 0)
    return yield* new UpstreamTokenLoadError({ message: 'Upstream token file is empty' })
  return { ...config, upstreamToken: Redacted.make(token) }
})
