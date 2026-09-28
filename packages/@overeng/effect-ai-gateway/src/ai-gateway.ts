import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai-compat'
import { Config, Effect, Layer, Option, type Redacted } from 'effect'
import type { LanguageModel } from 'effect/ai'
import type * as AiModel from 'effect/ai/Model'
import type { HttpClient } from 'effect/http'

type ModelConfig = Parameters<typeof OpenAiLanguageModel.model>[1]

type ClientOptions = {
  readonly url: string
  readonly token?: Redacted.Redacted<string> | undefined
}

type ModelOptions = {
  readonly model: string
  readonly config?: ModelConfig | undefined
}

/** Gateway origin excludes `/v1`; model IDs are passed through without rewriting. */
export const clientLayer = ({
  url,
  token,
}: ClientOptions): Layer.Layer<OpenAiClient.OpenAiClient, never, HttpClient.HttpClient> =>
  OpenAiClient.layer({ apiUrl: `${url.replace(/\/+$/, '')}/v1`, apiKey: token })

/** Read AI_GATEWAY_URL and the optional, redacted AI_GATEWAY_TOKEN. */
export const clientLayerConfig: Layer.Layer<
  OpenAiClient.OpenAiClient,
  Config.ConfigError,
  HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.String('AI_GATEWAY_URL')
    const token = yield* Config.option(Config.Redacted('AI_GATEWAY_TOKEN'))
    return clientLayer({ url, token: Option.getOrUndefined(token) })
  }),
)

/** Provide a language model and configured gateway client; the caller provides HttpClient. */
export const layer = ({
  url,
  token,
  model,
  config,
}: ClientOptions & ModelOptions): Layer.Layer<
  LanguageModel.LanguageModel,
  never,
  HttpClient.HttpClient
> => OpenAiLanguageModel.layer({ model, config }).pipe(Layer.provide(clientLayer({ url, token })))

/** Load the gateway connection from env while selecting the model explicitly. */
export const layerConfig = ({
  model,
  config,
}: ModelOptions): Layer.Layer<
  LanguageModel.LanguageModel,
  Config.ConfigError,
  HttpClient.HttpClient
> => OpenAiLanguageModel.layer({ model, config }).pipe(Layer.provide(clientLayerConfig))

/** A per-call model descriptor, requiring a gateway client layer in the context. */
export const model = ({
  model: modelId,
  config,
}: ModelOptions): AiModel.Model<'openai', LanguageModel.LanguageModel, OpenAiClient.OpenAiClient> =>
  OpenAiLanguageModel.model(modelId, config)
