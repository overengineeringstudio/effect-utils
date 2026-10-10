# Effect AI Gateway — Specification

This document specifies the Effect AI gateway integration. It builds on [requirements.md](./requirements.md).

## Status

Active.

## Scope

Defines the Effect chat and decision layers over [the shared wire](../spec.md). Does not define the gateway implementation, subscription routing, or secret provisioning (AIG.EFF-R06).

## Chat layers (AIG.EFF-R01–AIG.EFF-R03, AIG.EFF-R06)

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

`url` / `AI_GATEWAY_URL` follows the [root connection convention](../spec.md#connection-and-authentication-aig-r02-aig-r04). Trailing slashes are removed before appending `/v1`. Model IDs pass through unchanged: the wrapper neither parses the prefix nor rewrites IDs. Streaming Chat Completions requests include `stream_options.include_usage: true`; usage supplied by the gateway flows through Effect AI (AIG.EFF-R03, AIG-T02).

## Structured output (AIG.EFF-R04, AIG.EFF-R07)

```text
LanguageModel.generateObject + schema
    → compat provider response_format
    → gateway/model adapts schema or rejects request
    → Effect AI validates the original schema or fails
```

The compatible provider supplies `response_format`; gateway adaptation follows [the root structured-output contract](../spec.md#structured-output-aig-r05-aig-r06). `LanguageModel.generateObject` checks the returned value against the caller's original Effect Schema. Relaxed strictness and description-only provider constraints do not weaken that local validation. A rejected request or invalid value remains an Effect AI error.

## Decision models (AIG.EFF-R05, AIG.EFF-R07)

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

## Tools and telemetry (AIG.EFF-R08, AIG.EFF-R09)

```text
Effect AI operation -> compatible provider -> shared chat/tool wire
       |
       +-> caller-provided tracing -> GenAI operation span
```

Tool definitions, assistant tool-call IDs/arguments, and subsequent tool results
use Effect AI's existing tool surface over the root Chat Completions contract.
The gateway wrapper does not execute application tools itself.

The compatible provider's `OpenAiTelemetry` supplies inherited `gen_ai.*` and
`gen_ai.openai.*` annotations when tracing is supplied. The caller owns
tracing/export layers; the wrapper does not install exporters or duplicate
provider spans. The [root telemetry contract](../spec.md#client-telemetry-aig-r12)
constrains semantic attributes, stream lifetime, usage, and failures. Existing
provider annotations alone are not evidence of complete native-decision or
stream-lifetime telemetry conformance.
