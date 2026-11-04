# AI Gateway Edge — Specification

This document specifies `@overeng/ai-gateway-edge`. It builds on [requirements.md](./requirements.md) and inherits the [root wire specification](../spec.md).

## Status

Active.

## Scope

Defines the runtime-configured Node HTTP edge, digest authentication, forwarding and Prometheus accounting. Does not define provider routing, secret custody, hosts, firewall policy, or NixOS/Home Manager deployment. Client-side original-schema and decision validation remain in the [Effect](../01-effect/spec.md) and [Rust](../02-rust/spec.md) realizations.

## Runtime composition (AIG.EDGE-R01, AIG.EDGE-R02)

```text
runtime JSON -> GatewayConfig -> makeRoutes -> Node HTTP listener
                                  |                  |
                                  v                  v
                                Metrics       upstream origin
                                  |
                           optional metrics listener
```

`GatewayConfig` decodes `{ upstream: URLFromString, consumers: Array<{ name: trimmed nonempty string, tokenSha256: lowercase hex SHA-256 }>, maxModelLabels?: nonnegative integer, maxRequestBodyBytes?: positive integer, routeMaxRequestBodyBytes?: { "/v1/responses"?: positive integer } }`. Names and digests must each be unique. `maxModelLabels` defaults to 64 when omitted; zero aggregates every successful model into `_other`. `maxRequestBodyBytes` defaults to 1048576 (1 MiB). `routeMaxRequestBodyBytes["/v1/responses"]`, when supplied, replaces that global limit only for the exact Responses route; absence falls back to the global limit. Consumer names are deployer-owned opaque, case-sensitive strings; they are not provider accounts or request-body identities. Metric serialization escapes backslashes, quotes and newlines. The package imposes no preselected consumer vocabulary. `fixture-consumer` is an example; an empty or whitespace-padded name and a non-64-digit digest are invalid.

`loadConfig(path)` requires Effect FileSystem and reports `ConfigLoadError` for read/decode errors. `makeRoutes({ config, metrics? })` returns `{ router, metrics }`; `Metrics.render()` exposes the text scrape. Accounting methods take named objects: `Metrics.record({ labels, status, seconds })` and `Metrics.addTokens({ labels, status, kind, count })`. The CLI provides:

```text
ai-gateway-edge serve --config <path> --bind <host:port> [--metrics-bind <host:port>]
ai-gateway-edge hash-token
```

`hash-token` reads stdin and removes one trailing newline before SHA-256 hashing. Listener addresses are required CLI inputs, not baked-in defaults; bracketed IPv6 is accepted. A separate metrics listener serves only `GET /metrics` when configured. Its network exposure is the deployer's responsibility.

## Request and response flow (AIG.EDGE-R01, AIG.EDGE-R03–R05)

```text
bearer -> digest comparison -> bound body -> decode model -> chat-only usage forcing -> upstream
            |                    |              |                                 |
           401                  413            400                         status + bytes
                                                                    |
                                                          usage observation
```

1. Protect `GET /v1/models` and `POST /v1/chat/completions`, `/v1/responses`, `/v1/systemone`, `/alpha/decisions`. Parse the root's exact bearer grammar, hash it, and compare all configured digests with `timingSafeEqual`, including on absent or malformed bearer. Rejection returns `{ "error": { "message": "Invalid bearer token", "type": "authentication_error", "code": null } }` with 401.
2. After authentication, select the configured Responses route override or the global `maxRequestBodyBytes`. Reject a declared Content-Length above this effective limit before reading. Otherwise count incoming raw bytes while consuming the stream; stop at the first chunk that would exceed the limit, without retaining that chunk or waiting for the upload to finish. Exactly the effective byte limit is accepted. An oversized request returns 413 with `{ "error": { "message": "Request body too large", "type": "gateway_error", "code": null } }` and never reaches the upstream. The bounded Node stream reader leaves the socket alive to send the rejection, then `Connection: close` prevents reuse with an unread upload. Only bounded bodies are decoded: POST requires JSON with a nonempty `model`; retain its exact ID. Reject malformed JSON or missing model with 400 and message `Invalid request JSON or model`. Nonstreaming requests, decision bodies, and all accepted Responses bodies retain their original bytes. Only streaming Chat Completions merges `stream_options` and overwrites `include_usage: true`. Responses never receives forced `store` or usage options.
3. Strip Authorization, Host, Content-Length, standard hop-by-hop headers and headers named by Connection. Request `accept-encoding: identity`. The existing native fetch transport binds cancellation to both the Effect signal and the downstream Node socket, allowing stream teardown when the consumer disconnects.
4. A transport failure before a response returns 502 and message `Upstream unavailable`. Local 400/413/502 errors use the same envelope with `type: gateway_error` and null `code`. Upstream HTTP errors retain their own status and envelope; no retry or normalization is performed.
5. Filter response hop-by-hop headers and Content-Encoding. SSE bytes stream unchanged; a bounded UTF-8 event observer reads usage without rewriting content, `[DONE]`, or error frames. Non-SSE bytes are collected unchanged for optional JSON usage observation. Malformed usage is ignored, not replaced by zero. Body interruption remains a stream failure.
6. Unauthenticated `GET /healthz` probes upstream `/healthz`, returning the root's 200/503 health envelopes.

### Responses pass-through boundary (AIG.EDGE-R04)

`POST /v1/responses` forwards the OpenAI Responses wire, not a conversion to Chat Completions. The route uses the same digest authentication, credential stripping, global request-byte bound, cancellation, status/header preservation, and streaming transport as other protected POST routes. Effect and Rust clients expose no Responses operation.

After bounded JSON/model decoding and before forwarding, reject a non-null `previous_response_id`, any `conversation` field (including null), or an `input` array item whose `type` is `item_reference`. These requests receive 400 with `type: gateway_error`, null `code`, and a clear message identifying unsupported upstream state references; no request reaches the upstream. Consumer authentication does not establish ownership of IDs in the shared upstream account. No `GET /v1/responses/{id}` or conversation routes are exposed.

For each input object, the reference classification is `type === "item_reference" || ((type is absent || type === null) && role is absent)`. The upstream item-reference `type` is optional, so an ID-only object or `{ "id": "msg_example", "type": null }` is rejected. A typeless `{ "role": "user", "content": "hi" }` remains a valid EasyInputMessage. Typed complete items retain their IDs: `message`, `reasoning` with `encrypted_content`, `function_call`, and `function_call_output` are not rejected merely for carrying `id`.

Caller-carried continuity uses `store: false`, `include: ["reasoning.encrypted_content"]`, and complete prior output items echoed in the next request's `input`. Stateless item forms include `message`, `reasoning` with `encrypted_content`, `function_call`, and `function_call_output`. The edge neither decrypts nor rewrites these items and does not force those request fields. Size the optional Responses byte-limit override for the intended context: roughly four bytes per context token is a planning approximation, to which encrypted reasoning and JSON escaping/structure add overhead; token capacity is not an exact byte guarantee. The tradeoffs and official wire references are recorded in [Decision 0004](../.decisions/0004-responses-pass-through.md).

## Accounting (AIG.EDGE-R06)

| Metric                                                           | Labels                    | Meaning                                                  |
| ---------------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `requests_total`                                                 | `consumer, model, status` | Authenticated response count                             |
| `tokens_total`                                                   | `consumer, model, kind`   | Supplied `input`, `output`, `cached`, `reasoning` tokens |
| `request_duration_seconds_bucket`                                | `consumer, model, le`     | Cumulative duration histogram                            |
| `request_duration_seconds_sum`, `request_duration_seconds_count` | `consumer, model`         | Duration aggregate                                       |

The package owns these case-sensitive Prometheus metric identifiers. Consumer values are escaped configuration values. Request, token and duration metrics share one model-label admission set per `Metrics` instance:

1. Non-2xx responses, including local 400/413/502 errors, use `_rejected` and do not admit request model values.
2. Upstream 2xx responses may retain at most `maxModelLabels` distinct model values across all configured consumers. Discovery's synthetic `models` value also consumes one slot.
3. Once the cap is reached, newly observed successful models use `_other`; previously admitted models retain their own label. `_other` and `_rejected` are reserved aggregate values, not admission-set entries.
4. The cap bounds all model-keyed maps and Prometheus series; it does not rewrite, reject, or constrain the model sent upstream. Optional supplied usage on an error response is counted under `_rejected`.

`new Metrics(maxModelLabels = 64)` accepts a nonnegative safe integer. Names are never evicted from its bounded admission set, so repeated model values keep a stable bucket. Histogram bounds are 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300 seconds and `+Inf`. Token counts accept only nonnegative safe integers. Request duration ends at body completion/cancellation; no prompt, bearer, tool payload, or provider cost is a label.

Usage observation is endpoint-specific; Responses is not parsed as Chat Completions:

| Wire | Usage location | Input / output | Cached / reasoning |
| ---- | -------------- | -------------- | ------------------ |
| Chat JSON or SSE usage chunk | `usage` | `prompt_tokens` / `completion_tokens` | `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens` |
| Responses JSON | `usage` | `input_tokens` / `output_tokens` | `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens` |
| Responses terminal SSE event | `response.usage` on `response.completed`, `response.incomplete`, or `response.failed` | `input_tokens` / `output_tokens` | `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens` |

Responses SSE accounting observes terminal usage exactly once per request, not snapshots on `response.created` or `response.in_progress`, deltas, or repeated terminal events. It preserves every event byte, including failed/incomplete payloads; observation does not turn an application failure into a successful response. Each count must be a supplied nonnegative safe integer; explicit zero is preserved, while absent, null, malformed, negative, fractional, or unsafe counts produce no corresponding token metric. Do not derive missing counts from `total_tokens`, output text, or other counts.

Usage counts are decoded independently for every wire, including Chat Completions: a malformed cached-token detail does not discard valid input, output, or reasoning counts.

Responses terminal events embed the complete `response.output`, not only usage. The Responses SSE observer therefore permits 16,777,216 UTF-16 code units per line and per accumulated event payload; other routes retain 65,536 per line and 131,072 per payload. This fixed allowance accommodates multi-megabyte terminal output while bounding retained line plus event text to roughly 64 MiB per active observer (excluding transient decoding/parsing allocations). Oversized events are discarded from observation in their entirety, never parsed as truncated JSON; subsequent events remain observable. Forwarding is independent of these observation limits and remains incremental and byte-exact. This is an observation limit, not a response-size restriction.

An authenticated Responses body `{}` is rejected locally as a missing-model request, before upstream fetch, with 400 `gateway_error` and no token metrics. `input` is not required by the edge.

## Shared conformance (AIG.EDGE-R07)

`Proxy.integration.test.ts` loads `@overeng/ai-gateway-conformance` cases with `loadCases`, renders their upstream responses with `toHttpClientResponse`, and sends each request through an ephemeral loopback Node edge listener. It asserts bearer rejection before forwarding, credential stripping, unchanged endpoint/method/body except chat-only forced streaming usage, exact upstream status/content type/response bytes, and supplied usage accounting. Responses cases cover JSON and terminal SSE usage, upstream errors, and local state-reference rejection without forwarding. Additional integration coverage exercises config decoding, malformed payloads, hop-by-hop filtering, plaintext errors, both decision paths, bounded model accounting and incremental SSE delivery. The disconnect proof aborts a client after its first SSE event and requires the still-open upstream HTTP response to close before fixture teardown; a bounded deadline fails if cancellation is not propagated.

All cases on edge-supported endpoints are replayed as edge transport projections; a local-rejection case instead asserts that no upstream request occurs. The following case expectations are explicitly not applicable to the edge:

| Case                     | Inapplicable expectation and replay projection                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.stream.usage`      | No-bearer success is a client fake-transport convention, not protected-edge behavior. Replay supplies a fixture bearer and asserts SSE/usage preservation. |
| `decision.invalid-label` | No-bearer success and client-side label validation are not edge guarantees. Replay supplies a fixture bearer and asserts unchanged invalid output.         |
| `structured.invalid`     | Original-schema validation belongs to the consumer. Replay asserts unchanged invalid output so the consumer can reject it.                                 |

Case bodies are partial request matchers, so replay merges them with the case's model, stream and structured-format predicates to produce complete requests. Parsed tool calls, structured values and native probabilities are interpreted in consumer suites, not by the edge. No case is silently skipped.
