# Rust Client — Specification

This document specifies the Rust client realization. It builds on [requirements.md](./requirements.md) and uses the [parent wire specification](../spec.md) without redefining it.

## Status

Draft. The crate is `ai-gateway` at `rust/ai-gateway`, with library import name `ai_gateway` (naming decision q7). This node specifies the selected design, not an assertion of released implementation.

## Scope

Defines asynchronous client composition, schema validation, typed native decisions, and client-side telemetry. Does not define a blocking facade, gateway deployment, provider credential management, or application tool execution.

## Foundation and transport (AIG.RS-R01–AIG.RS-R05)

```text
Rust consumer -> wrapper -> async-openai client -> shared gateway wire
                    |            |
                    |            +-> rustls + ring; retries disabled
                    +-> BYOT: model listing and native decisions
```

[Decision 0001](./.decisions/0001-async-openai-foundation.md) selects async-openai as the foundation (decision q2, record `evlo3v`). Its typed Chat Completions surface supplies ordinary/streaming generation, response formats, and tool-call messages. All operations are async; the wrapper does not start a runtime or bridge to a blocking client.

The connection builder accepts an origin and an optional secret bearer and has an environment form using `AI_GATEWAY_URL` / `AI_GATEWAY_TOKEN`. It strips trailing slashes and sets the API base to the origin plus `/v1`. Absent token means absent Authorization, not an empty or dummy bearer. Diagnostic formatting redacts a supplied token. The HTTP stack selects rustls with the ring crypto provider; native-tls and platform TLS are not part of the supported feature set.

The wrapper replaces the foundation's default retrying Tower stack with a plain `ReqwestService` through `with_http_service`, with transport retries disabled. HTTP 429, 5xx, transport failure, and stream errors return to the caller; no wrapper retry loop replays requests. Error-body middleware retains raw unsuccessful response bodies that the SDK otherwise discards. Caller cancellation drops the in-flight operation or stream.

Model discovery and `/v1/systemone` use async-openai's BYOT (Bring Your Own Types) request/response transport on the same configured client. The wrapper defines catalog and decision wire types following the parent spec; it does not build a second reqwest client or introduce a provider SDK.

## Structured values (AIG.RS-R06, AIG.RS-R08)

```text
schemars original schema ---------> jsonschema validator
          |                                 ^
          v                                 |
strict provider projection -> response_format -> raw JSON value
                                              |
                                              +-> validated -> typed decoding
```

For a typed structured request, schemars generates the original schema. Preserve that schema unchanged and compile a jsonschema validator against it. Produce a separate provider projection: strict objects close additional properties and require projected properties; optional values use a nullable representation where needed. Resolve schema references for the provider form without modifying the original validation schema. A projection failure is local failure, not a request with the schema omitted.

Send the projection as `response_format.type = json_schema` with its schema name and requested strictness. The gateway may further relax strictness as described by the parent contract. Parse the returned text as one JSON value, validate it against the original schema, and only then decode the Rust type. Missing optional fields, explicit null, numeric bounds, and array bounds are governed by the original schema, not by the projection. Provider refusal, malformed JSON, constraint violations, and typed decode errors are failures rather than unchecked values.

## Native decisions and model discovery (AIG.RS-R04, AIG.RS-R07)

```text
encoded input + named questions -> BYOT /systemone -> raw answers
                                                        |
                                 original definitions <-+-> checked typed answers
```

Discovery decodes the parent's `object: list` catalog and retains model IDs and optional metadata without guessing aliases or availability. Decision calls encode input and named `choice`, `noul`, and `score` questions according to the parent wire. The default model is `openrouter/~typesafe/jev-latest`; an explicit model passes through unchanged. Responses supply answers and optional usage, not guaranteed model provenance.

Validate every requested answer: required names are present, returned kinds and labels match the declaration, numeric values are finite and in range, and probability distributions satisfy the parent's integrity rules. Never normalize malformed distributions or fill missing answers from chat output. Token counts and confidence remain provider-reported optional data.

## Tools and streaming (AIG.RS-R01, AIG.RS-R08)

```text
tool definitions -> chat -> tool-call deltas -> assembled calls -> consumer
consumer tool results -> next chat request
```

Preserve tool-call IDs and tool/function argument fragments. Assemble streamed arguments before attempting JSON decoding; the wrapper does not execute tools. Stream usage-only chunks with `choices: []` update operation usage rather than producing an empty-content error. A stream-level error after HTTP 200 is an error. EOF before the required completion sentinel is incomplete, and caller cancellation is not completed inference.

## GenAI telemetry (AIG.RS-R09)

```text
wrapper operation span
    +-> request -> response/stream consumption -> validation -> end
    +-> supplied usage and model attributes
    +-> error or cancellation outcome
```

The wrapper owns the semantic operation span, not async-openai internals. Follow [the parent's telemetry contract](../spec.md#client-telemetry-aig-r12) for names and `gen_ai.*` attributes. Ordinary/structured chat and a model tool-call exchange are chat operations; native decisions use the documented decision operation. Keep the span open through final usage and local validation, or through error/cancellation, including when the consumer drops a stream. There is no detached success span created merely by receiving HTTP 200.

Consumers supply OpenTelemetry subscribers/providers and exporters; the wrapper does not install process-global telemetry. No bearer, raw prompt, response text, or tool arguments are captured by default.

