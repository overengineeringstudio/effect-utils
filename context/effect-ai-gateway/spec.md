# Effect AI Gateway — Specification

This document specifies the Effect AI gateway integration. It builds on [requirements.md](./requirements.md).

## Status

Active.

## Scope

Defines the consumer-facing chat and decision layers and the gateway wire contract. Does not define the gateway implementation, subscription routing, or secret provisioning (R08).

## Chat layers (R01–R04, R08)

```text
Consumer + HttpClient
    │ AiGateway layer / model
    ▼
@effect/ai-openai-compat
    │ OpenAI Chat Completions, bearer if configured
    ▼
Gateway /v1/chat/completions → model selected by provider-prefixed ID
```

`AiGateway` from `@overeng/effect-ai-gateway` exposes these signatures (layer requirements include `HttpClient.HttpClient`):

```ts
AiGateway.layer({ url, token?, model, config? })
AiGateway.layerConfig({ model, config? })
AiGateway.clientLayer({ url, token? })
AiGateway.clientLayerConfig
AiGateway.model({ model, config? })
```

`layer` and `layerConfig` provide `LanguageModel.LanguageModel`; `clientLayer` and `clientLayerConfig` provide the OpenAI-compatible client for per-call `model` selection. Explicit `token` is `Redacted<string>`. Config layers read `AI_GATEWAY_URL` and optional redacted `AI_GATEWAY_TOKEN`. The consumer provides an Effect `HttpClient` layer, such as `FetchHttpClient.layer` from `effect/http/FetchHttpClient`.

`url` / `AI_GATEWAY_URL` is the gateway origin **without** `/v1`; trailing slashes are removed before appending `/v1`. Model IDs are passed through unchanged, using the gateway's provider-prefixed IDs advertised at `GET /v1/models` (for example `anthropic/claude-haiku-4-5`). The gateway owns the identifier namespace and routing: the wrapper neither parses the prefix nor rewrites IDs. Streaming Chat Completions requests include `stream_options.include_usage: true`; usage supplied by the gateway flows through Effect AI (R03, T02).

## Structured output (R05)

```text
LanguageModel.generateObject + schema
    → compat provider response_format
    → gateway/model enforces format or rejects request
    → Effect AI validates returned value or fails
```

The gateway must support Chat Completions `response_format` for structured output. A model may reject a schema or produce invalid output; neither a rejected constraint nor an invalid result becomes a successful structured value. Schema support is model-dependent (T01). Observed gateway bakeoff results for two model families and two schema shapes: after schema handling was corrected, native formatting produced 19/20 schema-valid raw results; forced tool output produced 20/20. Ten additional `generateObject` calls yielded schema-valid decoded values. These observations do not guarantee portable native schema support or future model reliability.

## Decision models (R04, R06–R08)

```text
Decision.make(input schema, named classify/probability/rate decisions)
    → DecisionModel.decide({ input })
    → AiGateway.decisionLayer / decisionLayerConfig
    → @effect/ai-typesafe → POST <gateway-origin>/v1/systemone
    → typed checked answers + available usage
```

`AiGateway.decisionLayer({ url, token?, model? })` and `AiGateway.decisionLayerConfig({ model? })` provide Effect `DecisionModel.DecisionModel` using `TypeSafeDecisionModel.layer` and `TypeSafeClient.layer`. The client uses `apiUrl: <gateway-origin>/v1`, and the same redacted bearer configuration and caller-provided `HttpClient` as chat. The default decision model ID is `openrouter/~typesafe/jev-latest`; an explicitly chosen ID passes through unchanged. Decision inputs are encoded using the declared schema; the provider's answers are checked against the named decision definitions. The response contains `answers` and `usage` (token counts when supplied), not a guaranteed model or source field. Classification labels and rating labels are typed from the declaration; probability answers represent the decision provider's probability, not confidence inferred from chat text.

`decisionLayerConfig()` may omit its options entirely. Both connection forms share the chat URL/token environment contract and normalize trailing slashes before appending `/v1`. A TypeSafe response with an unknown label, absent named answer, or invalid probability distribution fails as an Effect `AiError` with `InvalidOutputError`; the wrapper never coerces malformed answers into a successful decision.

The gateway's decision endpoint is distinct from Chat Completions; chat-based object generation is not a substitute for the native `DecisionModel` contract. The TypeSafe provider's higher-level question DSL is limited to Effect `Decision` definitions rather than promising every shape accepted by the underlying wire protocol.
