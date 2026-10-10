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

`GatewayConfig` decodes `{ upstream: URLFromString, consumers: Array<{ name: trimmed nonempty string, tokenSha256: lowercase hex SHA-256 }>, maxModelLabels?: nonnegative integer }`. Names and digests must each be unique. `maxModelLabels` defaults to 64 when omitted; zero aggregates every successful model into `_other`. Consumer names are deployer-owned opaque, case-sensitive strings; they are not provider accounts or request-body identities. Metric serialization escapes backslashes, quotes and newlines. The package imposes no preselected consumer vocabulary. `fixture-consumer` is an example; an empty or whitespace-padded name and a non-64-digit digest are invalid.

`loadConfig(path)` requires Effect FileSystem and reports `ConfigLoadError` for read/decode errors. `makeRoutes(config, metrics?)` returns `{ router, metrics }`; `Metrics.render()` exposes the text scrape. The CLI provides:

```text
ai-gateway-edge serve --config <path> --bind <host:port> [--metrics-bind <host:port>]
ai-gateway-edge hash-token
```

`hash-token` reads stdin and removes one trailing newline before SHA-256 hashing. Listener addresses are required CLI inputs, not baked-in defaults; bracketed IPv6 is accepted. A separate metrics listener serves only `GET /metrics` when configured. Its network exposure is the deployer's responsibility.

## Request and response flow (AIG.EDGE-R01, AIG.EDGE-R03–R05)

```text
bearer -> digest comparison -> decode model -> force stream usage -> upstream
            |                      |                                 |
           401                    400                         status + bytes
                                                                    |
                                                          usage observation
```

1. Protect `GET /v1/models` and `POST /v1/chat/completions`, `/v1/systemone`, `/alpha/decisions`. Parse the root's exact bearer grammar, hash it, and compare all configured digests with `timingSafeEqual`, including on absent or malformed bearer. Rejection returns `{ "error": { "message": "Invalid bearer token", "type": "authentication_error", "code": null } }` with 401.
2. POST requires JSON with a nonempty `model`; retain its exact ID. Reject malformed JSON or missing model with 400 and message `Invalid request JSON or model`. Nonstreaming requests and decision bodies retain their original bytes. Streaming chat merges `stream_options` and overwrites only `include_usage: true`.
3. Strip Authorization, Host, Content-Length, standard hop-by-hop headers and headers named by Connection. Request `accept-encoding: identity`. The existing native fetch transport binds cancellation to both the Effect signal and the downstream Node socket, allowing stream teardown when the consumer disconnects.
4. A transport failure before a response returns 502 and message `Upstream unavailable`. Local 400/502 errors use the same envelope with `type: gateway_error` and null `code`. Upstream HTTP errors retain their own status and envelope; no retry or normalization is performed.
5. Filter response hop-by-hop headers and Content-Encoding. SSE bytes stream unchanged; a bounded UTF-8 event observer reads usage without rewriting content, `[DONE]`, or error frames. Non-SSE bytes are collected unchanged for optional JSON usage observation. Malformed usage is ignored, not replaced by zero. Body interruption remains a stream failure.
6. Unauthenticated `GET /healthz` probes upstream `/healthz`, returning the root's 200/503 health envelopes.

## Accounting (AIG.EDGE-R06)

| Metric                                                           | Labels                    | Meaning                                                  |
| ---------------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `requests_total`                                                 | `consumer, model, status` | Authenticated response count                             |
| `tokens_total`                                                   | `consumer, model, kind`   | Supplied `input`, `output`, `cached`, `reasoning` tokens |
| `request_duration_seconds_bucket`                                | `consumer, model, le`     | Cumulative duration histogram                            |
| `request_duration_seconds_sum`, `request_duration_seconds_count` | `consumer, model`         | Duration aggregate                                       |

The package owns these case-sensitive Prometheus metric identifiers. Consumer values are escaped configuration values. Request, token and duration metrics share one model-label admission set per `Metrics` instance:

1. Non-2xx responses, including local 400/502 errors, use `_rejected` and do not admit request model values.
2. Upstream 2xx responses may retain at most `maxModelLabels` distinct model values across all configured consumers. Discovery's synthetic `models` value also consumes one slot.
3. Once the cap is reached, newly observed successful models use `_other`; previously admitted models retain their own label. `_other` and `_rejected` are reserved aggregate values, not admission-set entries.
4. The cap bounds all model-keyed maps and Prometheus series; it does not rewrite, reject, or constrain the model sent upstream. Optional supplied usage on an error response is counted under `_rejected`.

`new Metrics(maxModelLabels = 64)` accepts a nonnegative safe integer. Names are never evicted from its bounded admission set, so repeated model values keep a stable bucket. Histogram bounds are 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300 seconds and `+Inf`. Token counts accept only nonnegative safe integers. Request duration ends at body completion/cancellation; no prompt, bearer, tool payload, or provider cost is a label.

## Shared conformance (AIG.EDGE-R07)

`Proxy.integration.test.ts` loads `@overeng/ai-gateway-conformance` cases with `loadCases`, renders their upstream responses with `toHttpClientResponse`, and sends each request through an ephemeral loopback Node edge listener. It asserts bearer rejection before forwarding, credential stripping, unchanged endpoint/method/body except forced streaming usage, exact upstream status/content type/response bytes, and supplied usage accounting. Additional integration coverage exercises config decoding, malformed payloads, hop-by-hop filtering, plaintext errors, both decision paths, bounded model accounting and incremental SSE delivery. The disconnect proof aborts a client after its first SSE event and requires the still-open upstream HTTP response to close before fixture teardown; a bounded deadline fails if cancellation is not propagated.

All 16 current cases have edge-supported endpoints and are replayed as edge transport projections. The following case expectations are explicitly not applicable to the edge:

| Case                     | Inapplicable expectation and replay projection                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.stream.usage`      | No-bearer success is a client fake-transport convention, not protected-edge behavior. Replay supplies a fixture bearer and asserts SSE/usage preservation. |
| `decision.invalid-label` | No-bearer success and client-side label validation are not edge guarantees. Replay supplies a fixture bearer and asserts unchanged invalid output.         |
| `structured.invalid`     | Original-schema validation belongs to the consumer. Replay asserts unchanged invalid output so the consumer can reject it.                                 |

Case bodies are partial request matchers, so replay merges them with the case's model, stream and structured-format predicates to produce complete requests. Parsed tool calls, structured values and native probabilities are interpreted in consumer suites, not by the edge. No case is silently skipped.
