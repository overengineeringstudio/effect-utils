# @overeng/effect-ai-gateway

Backend-neutral Effect AI `LanguageModel` and `DecisionModel` layers for subscription-backed models reached through a compatible gateway. The gateway, not this package, manages provider subscriptions and model routing.

The language-neutral [AI gateway contract](../../../context/ai-gateway/vision.md)
owns the public wire and shared semantics. This package realizes its
[Effect requirements](../../../context/ai-gateway/01-effect/requirements.md)
and [specification](../../../context/ai-gateway/01-effect/spec.md);
the [Rust realization](../../../context/ai-gateway/02-rust/spec.md) shares that
contract without defining a second gateway protocol.

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

## Native decisions

```ts
import { AiGateway } from '@overeng/effect-ai-gateway'
import { Effect, Layer, Schema } from 'effect'
import { Decision, DecisionModel } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

const triage = Decision.make({
  input: Schema.Struct({ ticket: Schema.String }),
  decisions: {
    department: Decision.classify({
      instructions: 'Which team handles this?',
      criteria: { billing: 'Payments', technical: 'Bugs' },
    }),
    urgent: Decision.probability({ instructions: 'Needs action today?' }),
    frustration: Decision.rate({
      instructions: 'How frustrated is the customer?',
      criteria: ['calm', 'frustrated', 'angry'],
    }),
  },
})

const decisions = AiGateway.decisionLayerConfig().pipe(Layer.provide(FetchHttpClient.layer))
const result = await Effect.runPromise(
  DecisionModel.decide(triage, { input: { ticket: 'Charged twice' } }).pipe(
    Effect.provide(decisions),
  ),
)
// result.answers.department.label: 'billing' | 'technical'
// result.answers.urgent.probability: number
// result.answers.frustration.label: 'calm' | 'frustrated' | 'angry'
console.log(result.answers, result.usage)
```

`AiGateway.decisionLayer({ url, token?, model? })` accepts the same gateway origin and optional redacted bearer as chat. `decisionLayerConfig({ model? })` reads `AI_GATEWAY_URL` and optional `AI_GATEWAY_TOKEN`; both default to `openrouter/~typesafe/jev-latest` when `model` is omitted. The native `@effect/ai-typesafe` provider sends one batch to `<gateway-origin>/v1/systemone` and validates labels, probabilities, and ratings against the `Decision.make` definition. The gateway must expose that endpoint separately from Chat Completions. Decision probabilities are provider results, not inferred from chat text; malformed answers fail with `AiError`. Supply an Effect `HttpClient` layer in either case.

Structured output requires gateway support for Chat Completions `response_format` and model support for the requested JSON format; not all models honor it. This package does not expose a gateway, authenticate subscription providers, translate other wire protocols, or supply an HTTP runtime. Gateway failures and provider limitations remain visible as Effect AI errors.
