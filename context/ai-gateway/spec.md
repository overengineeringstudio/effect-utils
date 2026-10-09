# AI Gateway — Public Wire Specification

This document specifies the language-neutral gateway wire and shared client conventions. It builds on [requirements.md](./requirements.md).

## Status

Active for the documented wire. Client realizations refine this contract separately; this is not a claim that every implementation or model is conformant. Shared fixture publication is not yet established.

## Scope

Defines program-facing HTTP routes, authentication, payloads, SSE, schema adaptation, native decisions, and client telemetry. Does not define gateway topology, credential custody, server accounting, account-pinned routing, or provider-native endpoints. [Effect](./01-effect/spec.md) and [Rust](./02-rust/spec.md) own their language APIs (AIG-R09).

## Connection and authentication (AIG-R02, AIG-R04)

```text
origin -> /healthz                 (no bearer)
       -> /v1/models               (consumer bearer)
       -> /v1/chat/completions     (consumer bearer)
       -> /v1/systemone            (consumer bearer)
```

`AI_GATEWAY_URL` is the gateway origin, without `/v1`, query, or fragment. Clients remove trailing slashes and append `/v1` once for application endpoints. `AI_GATEWAY_TOKEN` is the optional consumer bearer in the environment convention; explicit connection settings use the same semantics. Example: `https://gateway.example` becomes `https://gateway.example/v1`. An input already ending in `/v1` is not the origin convention.

Protected operations send `Authorization: Bearer <token>`. `Bearer` is case-sensitive; a token is a nonempty, whitespace-free opaque string. When no token is configured, a client omits Authorization entirely rather than sending an empty bearer. Protected gateways reject missing, invalid, or revoked tokens with HTTP 401. Token omission supports caller-controlled test transports, not anonymous access to protected routes. A token identifies one consumer, not a provider account or a request-body identity. Bearers are never included in diagnostic configuration or telemetry, and client libraries do not provision them.

JSON requests use `Content-Type: application/json`. Chat responses are JSON unless `stream: true`, which selects `text/event-stream`. Health requires no consumer bearer: HTTP 200 with `{"status":"ok"}` means the gateway health check succeeded; HTTP 503 with `{"status":"unavailable"}` means unavailable. Health success does not prove a selected model is usable.

### Identifier ownership and compatibility

| Identifier | Owner and grammar | Reader behavior |
| --- | --- | --- |
| HTTP paths, JSON keys, SSE `data` framing | OpenAI-compatible chat convention, with this contract's health and System One routes; case-sensitive | Use exact documented paths and discriminators; additional provider metadata may be retained without assigning new semantics. |
| Model ID | Gateway catalog/provider namespace; nonempty `provider/model` string; prefix and remainder are opaque, case-sensitive catalog data | Preserve exact IDs, including slashes and `~` within the remainder. Never infer provider protocol, rewrite aliases, or assume availability from syntax. |
| Decision question name | Caller-owned nonempty JSON object key, case-sensitive and unique within one request | Response keys correlate by exact name; missing requested names fail validation. |
| `AI_GATEWAY_URL`, `AI_GATEWAY_TOKEN` | Repository-owned cross-language convention, uppercase ASCII names | Not OpenAI-standard `OPENAI_*` variables; no implicit fallback to a public provider endpoint. |
| Response-format and question `type` | This wire's documented lowercase discriminators | One discriminator selects one semantic axis. Unknown types are not a supported request. |

Examples: `anthropic/claude-haiku-4-5` is a provider ID;
`openrouter/~typesafe/jev-latest` is a route/alias ID;
`example-provider/private-model` illustrates a private catalog entry, not a special protocol.
A bare `private-model`, an empty ID, or a caller-invented alias not in the catalog is not a discovered model identity. Unknown models fail rather than being guessed. These identifiers are not URI schemes or registered media types.

## Model discovery (AIG-R01, AIG-R04)

```text
GET /v1/models -> object: list -> data[] -> unchanged model IDs
```

The catalog envelope is:

```json
{
  "object": "list",
  "data": [{
    "id": "anthropic/claude-haiku-4-5",
    "object": "model",
    "owned_by": "anthropic",
    "api": "anthropic-messages",
    "display_name": "Claude Haiku 4.5",
    "input_modalities": ["text", "image"],
    "context_length": 200000,
    "max_output_tokens": 64000
  }]
}
```

The envelope and row `id` identify the listing and model. Catalog rows may include `object`, `owned_by`, `api`, `display_name`, `input_modalities`, `context_length`, `max_output_tokens`, and `kind` for non-chat models. `supports_tools` is emitted when explicitly false; its absence does not promise support. `created` is not required and can be absent. Clients must not require OpenAI's complete catalog row schema or select transport based on `api`. Unknown metadata is not an error. Listing does not prove available credentials, schema support, or operational readiness.

## Chat JSON (AIG-R01, AIG-R03, AIG-R11)

```text
messages + model + optional tools/format -> POST /v1/chat/completions
                                       <- choices + usage or HTTP error
```

A minimal request is `{"model":"anthropic/claude-haiku-4-5","messages":[{"role":"user","content":"Say hello"}],"stream":false}`. `model` is a nonempty advertised ID. Message roles include `system`, `developer`, `user`, `assistant`, and `tool`; legacy `function` input may be accepted but is not the client convention. Content can be text or OpenAI-style content parts. Data-URI image parts can be decoded; remote image URLs are not guaranteed image inputs and may become text placeholders.

The gateway parses common Chat Completions fields including `tools`, `tool_choice`, `response_format`, `stream_options`, `max_completion_tokens` (preferred to `max_tokens`), `temperature`, `top_p`, `stop`, penalties, `reasoning_effort`, `service_tier`, metadata, and cache keys. Parsing does not guarantee every provider honors every tuning field: sampling controls can be stripped by a backend, and fields such as `seed`, `logit_bias`, `parallel_tool_calls`, and `user` are not portable guarantees. This contract does not promise complete OpenAI API parity or expose Responses, Messages, embedding, or audio routes.

A representative nonstreaming response is:

```json
{
  "id": "chatcmpl-example",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "anthropic/claude-haiku-4-5",
  "choices": [{
    "index": 0,
    "message": {"role":"assistant", "content":"Hello"},
    "finish_reason": "stop",
    "logprobs": null
  }],
  "usage": {"prompt_tokens":12, "completion_tokens":2, "total_tokens":14}
}
```

Choices contain assistant messages, nullable content, optional `tool_calls` and `reasoning_content`, and a finish reason such as `stop`, `length`, or `tool_calls`. Usage, when supplied, has `prompt_tokens`, `completion_tokens`, and `total_tokens`; details may include `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`. Prompt usage can include cache reads/writes. Preserve reported counts, including an explicit zero; absence remains unknown. Nonstreaming provider JSON and error status are not replaced by synthesized successful content.

### Tool exchange

```text
function definition -> assistant tool_calls -> caller executes tool
                    -> tool message with tool_call_id -> next completion
```

Tools use `{"type":"function","function":{"name":"lookup","description":"Look up a value","parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}}`. Returned calls have `id`, `type: "function"`, and `function: {name, arguments}` where arguments is a JSON-encoded string. The caller appends the assistant call message and a `role: "tool"` message with matching `tool_call_id` and result content. The client does not execute tools or invent call IDs. Streaming argument fragments are assembled before parsing; a partial argument string is not a completed tool call.

## Chat SSE (AIG-R03, AIG-R10, AIG-R11)

```text
HTTP 200 -> delta* -> finish_reason -> optional usage-only chunk -> [DONE]
                    \-> error event: failed operation, not success
```

Streaming requests set `stream: true` and `stream_options: {"include_usage":true}`. The gateway also requests usage upstream. SSE messages are separated by blank lines and use `data:` JSON, allowing incremental `choices[].delta` content and tool-call fragments. Clients must handle transport byte boundaries independently of event boundaries.

```text
data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-haiku-4-5","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-haiku-4-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-haiku-4-5","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}

data: [DONE]

```

The final usage-only chunk can have `choices: []`; it is not missing-output failure. Usage is optional even when requested. `[DONE]` terminates a completed stream; EOF before termination is incomplete, and receiving only headers or a finish chunk does not establish completion. Error events such as `data: {"error":{"message":"provider rejected request","type":"invalid_request_error"}}` can arrive after HTTP 200. They fail the operation even after partial deltas; a later sentinel does not undo the error. Caller cancellation stops consumption, notifies the transport, and is not completed inference.

## Structured output (AIG-R05, AIG-R06)

```text
original schema -> client projection -> response_format -> gateway adaptation
       |                                                       |
       +-------------------- local validation <--- raw JSON ---+
```

The supported response-format discriminators are:

| Mode | Request | Guarantee |
| --- | --- | --- |
| Text | `{"type":"text"}` | Ordinary text; no structured-value guarantee. |
| JSON object | `{"type":"json_object"}` | Request JSON object formatting, not validation against a caller schema; a backend may refuse it. |
| JSON Schema | `{"type":"json_schema","json_schema":{"name":"document","schema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false},"strict":true}}` | Request native schema formatting; original-schema validation remains a client obligation. `description` and `strict` are optional. |

Malformed known formats and unsupported constrained formats fail. Some providers refuse `json_object` and require `json_schema`. Schema names may be sanitized/truncated to 64 characters for provider transport; that does not change the validation schema.

The gateway can adapt provider-incompatible numeric/array bound keywords into descriptions and can change `strict: true` to `strict: false` when optional properties conflict with the provider's strict grammar. Such descriptions are guidance, not enforcement. The client retains the unmodified original schema and validates the returned JSON against it before reporting a successful structured value; a valid provider projection alone is insufficient. Refused schemas, malformed JSON, and original-schema violations remain failures.

Unknown future `response_format.type` values are outside this contract and clients reject them locally. Some existing parsers ignore unknown discriminators; callers must not rely on those parsers refusing an unknown format or count their resulting text as structured success.

## Native decisions (AIG-R07, AIG-R08)

```text
state + named questions -> POST /v1/systemone -> answers + optional usage
                                                |
                                definitions -> local integrity checks
```

This is a separate nonstreaming operation, not a chat fallback or persistent session. A request contains `model`, `state` (encoded input as a string or JSON object), and a `questions` object keyed by caller-defined names:

```json
{
  "model": "openrouter/~typesafe/jev-latest",
  "state": {"ticket":"Charged twice"},
  "questions": {
    "department": {"type":"choice", "instructions":"Which team handles this?", "criteria":{"billing":"Payments", "technical":"Bugs"}},
    "urgent": {"type":"noul", "instructions":"Needs action today?"},
    "frustration": {"type":"score", "instructions":"How frustrated is the customer?", "criteria":["calm","frustrated","angry"]}
  }
}
```

`instructions` may be a string or structured object accepted by the native provider. `choice` maps classification labels to criteria; `noul` asks for a probability; `score` uses ordered rating criteria. The default client model is `openrouter/~typesafe/jev-latest`; callers can supply an explicit catalog ID. The alias can follow provider releases; a pinned model is a distinct catalog identity. A judgment route may be API-billed; availability in the catalog does not promise credentials or subscription coverage.

```json
{
  "answers": {
    "department": {"type":"choice", "choice":"billing", "probabilities":{"billing":0.9,"technical":0.1}, "confidence":0.8},
    "urgent": {"type":"noul", "noul":0.7},
    "frustration": {"type":"score", "score":1.2, "probabilities":{"0":0,"1":0.8,"2":0.2}, "legend":{"0":"calm","1":"frustrated","2":"angry"}, "confidence":0.6}
  },
  "usage": {"input_tokens":218,"output_tokens":39}
}
```

Responses can include a resolved `model`, but clients cannot require model/source provenance. Usage is provider-reported `input_tokens`, `output_tokens`, and optional `cost`; do not fabricate missing counts or treat cost as a metric label.

Clients validate requested names and answer kinds against the original definitions. Choice labels and distribution keys must be declared options; score distribution keys/legend correspond to the ordered criteria, and a score is finite within `[0, criteria.length - 1]`. Probabilities, `noul`, and supplied confidence are finite within `[0,1]`. A categorical distribution covers its declared options and sums to one within floating-point tolerance; clients reject invalid distributions, unknown labels, and missing answers rather than renormalizing or coercing them. Language realizations define their exact numerical tolerance. Confidence is distinct from an option probability. Chat output never substitutes for native probability-bearing answers.

The gateway may also expose `POST /alpha/decisions` for the underlying decision-provider wire. It is not the portable client operation and is not required for `/v1/systemone` conformance.

## Failures (AIG-R10)

```text
request -> local validation / transport / HTTP refusal / stream error / output validation
        -> success only when the selected operation completes and checks pass
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON/model payload, malformed supported response format, or provider schema rejection. |
| 401 | Missing, invalid, or revoked consumer bearer. |
| 404 | Unknown model or route; no guessed alias fallback. |
| 422 | Invalid native decision request or a non-judgment model selected for decisions. |
| 429 | Provider/rate-limit refusal; preserve any Retry-After hint. |
| 499 | Request aborted where reported by the gateway. |
| 500 | Internal gateway/provider error. |
| 502 | Upstream transport unavailable. |
| 503 | Failed health check or upstream/service unavailable. |

Gateway-generated errors commonly have `{"error":{"message":"Invalid bearer","type":"authentication_error","code":null}}`; other gateway errors use `type: "gateway_error"`. Provider errors commonly have `{"error":{"message":"Unknown model","type":"invalid_request_error"}}` without `code` or `param`. Other failures can contain plain error strings or non-JSON bodies. Clients preserve HTTP status and available error type/message/raw body rather than requiring the full OpenAI error schema. Supplied provider statuses remain failures, even when not listed above. SSE errors retain their payload and operation failure even though the HTTP status is 200. Local schema/answer-validation failure is distinguishable from HTTP rejection.

## Client telemetry (AIG-R12)

```text
client operation span -> request -> body/stream consumption -> validation -> outcome
```

OpenTelemetry GenAI semantic conventions own standard `gen_ai.*` attributes;
[the upstream convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) defines their vocabulary.
Each realization supplies a client-kind operation span, not a telemetry exporter or server-accounting metric. Use `chat <requested-model>` for ordinary chat, structured chat, and model tool-call exchanges, with `gen_ai.operation.name = chat`. Native decisions use `decision <requested-model>` with `gen_ai.operation.name = decision`: `decision` is this contract's repository-local extension, not a claim of an upstream standard operation.

Retain `gen_ai.request.model`, available `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. Preserve supplied cached/reasoning usage without inventing values. The OpenAI-compatible wire does not imply that the provider is OpenAI; provider metadata must be truthful or omitted rather than hardcoded from transport choice. `span.label` is a short operation/model label, not request content.

A streaming span lasts until consumption ends and captures final usage before ending; output validation is inside the operation lifetime. HTTP/stream/provider/local validation failures set error status and available `error.type`; cancellation ends the span without reporting successful completed inference. Credentials, raw prompts, response text, tool arguments, and provider cost are excluded from default spans. Applications own exporters and process resource attributes; model identities are trace data, not automatically approved metric labels.

## Conformance cases (AIG-R01–AIG-R12)

```text
@overeng/ai-gateway-conformance: case.schema.json + cases/<id>.json
    +-> 01-effect: language-local replay
    +-> 02-rust: language-local replay
    +-> edge: gateway-local replay
```

The public package `@overeng/ai-gateway-conformance` owns data-only JSON cases at
`packages/@overeng/ai-gateway-conformance/cases`.
Its [`case.schema.json`](https://github.com/overengineeringstudio/effect-utils/blob/main/packages/%40overeng/ai-gateway-conformance/case.schema.json)
is the machine-readable case contract. [Decision 0003](./.decisions/0003-data-only-conformance-cases.md)
selects shared data and per-language replay, not a shared fake-gateway binary.

Each case supplies an ID, summary, requirement references, a request expectation,
a controlled response, and the expected consumer outcome. Request expectations
identify method, path, bearer presence, operation selectors, and any required
request-body subset. Responses carry an HTTP status, optional headers, and either
JSON or ordered SSE `data:` payloads (including `[DONE]`). Outcomes distinguish
success, HTTP failure, stream failure, and local validation failure, with
applicable text, object, usage, tool calls, error status/type, or decision answers.
Structured cases also retain the caller's original JSON Schema for validation.

| Case IDs | Contract exercised |
| --- | --- |
| `models.list`, `chat.text` | Model catalog and ordinary generation. |
| `chat.stream.usage`, `chat.stream.error-after-200` | Usage-only SSE chunks and errors after HTTP success. |
| `chat.auth.none-401` | Absent bearer and authentication rejection. |
| `structured.valid`, `structured.invalid`, `structured.rejected-400` | Structured success, original-schema validation, and format refusal. |
| `tools.call`, `tools.result` | Tool-call preservation and result continuation. |
| `decision.triage`, `decision.invalid-422` | Native decisions and rejected requests. |
| `errors.upstream-404`, `errors.rate-limited-429`, `errors.edge-502` | Distinguishable unsuccessful HTTP outcomes. |

The `01-effect`, `02-rust`, and edge realizations must replay every case. Each
realization owns its replay adapter and local controlled transport or server
harness; no case embeds executable code or a language-specific client API.
Client adapters assert outgoing request expectations and decoded outcomes;
the edge adapter supplies controlled upstream behavior and asserts the public
wire response and request acceptance. Language-specific tests additionally cover
telemetry lifetimes, cancellation, and other obligations not represented by
these data-only exchanges; passing the case set does not waive those requirements.
