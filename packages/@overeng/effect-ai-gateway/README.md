# @overeng/effect-ai-gateway

Backend-neutral Effect AI `LanguageModel` layers for subscription-backed models reached through an OpenAI Chat Completions-compatible gateway. The gateway, not this package, manages provider subscriptions and model routing.

```ts
import { AiGateway } from '@overeng/effect-ai-gateway'
import { Effect, Layer } from 'effect'
import { LanguageModel } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

const program = LanguageModel.generateText({ prompt: 'Say hello' })
const ai = AiGateway.layerConfig({ model: 'anthropic/claude-haiku-4-5' }).pipe(
  Layer.provide(FetchHttpClient.layer),
)
const result = await Effect.runPromise(program.pipe(Effect.provide(ai)))
console.log(result.text, result.usage)
```

Set `AI_GATEWAY_URL` to the gateway origin **without** `/v1`; `AI_GATEWAY_TOKEN` is an optional bearer token read as redacted config. Alternatively, use `AiGateway.layer({ url, token, model, config? })`; `token` is `Redacted<string>` and the `HttpClient` layer is always supplied by the consumer. For multiple models, provide `AiGateway.clientLayer({ url, token })` or `AiGateway.clientLayerConfig` and select `AiGateway.model({ model: id, config? })` per call.

Model IDs pass through unchanged; use provider-prefixed IDs advertised by the gateway's `/v1/models` (for example, `openai-codex/gpt-5.6-luna`). Streaming requests include `stream_options: { include_usage: true }` in the upstream `@effect/ai-openai-compat` client, so this wrapper does not transform request bodies.

Structured output requires gateway support for Chat Completions `response_format` and model support for the requested JSON format; not all models honor it. This package does not expose a gateway, authenticate subscription providers, translate other wire protocols, or supply an HTTP runtime. Gateway failures and provider limitations remain visible as Effect AI errors.
