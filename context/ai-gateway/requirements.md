# AI Gateway — Requirements

## Context

This language-neutral consumer contract refines [the vision](./vision.md).
[The public wire specification](./spec.md) is realized by the
[Effect client](./01-effect/requirements.md) and [Rust client](./02-rust/requirements.md).
A gateway realization owns deployment, credential custody, and server accounting outside this public tree.

## Assumptions

- **AIG-A01 Compatible gateway:** The gateway exposes the documented Chat Completions, model discovery, and native decision wire; catalog presence alone does not prove that a model can be served.
- **AIG-A02 Caller-owned application policy:** Consumers select advertised models, supply their own original schemas and decision definitions, and decide whether to retry a failed operation.

## Acceptable Tradeoffs

- **AIG-T01 Model-dependent formatting:** Native schema support varies by model. The gateway may adapt a requested schema or relax strict mode, but client validation against the original schema remains authoritative; description-only constraints are guidance, not enforcement.
- **AIG-T02 Optional usage:** Provider-reported usage is exposed when supplied. Missing usage is not invented or represented as a measured zero.
- **AIG-T03 Async surface:** An asynchronous client API is sufficient; a blocking facade is not required.

## Requirements

### Must preserve shared model access

- **AIG-R01 Chat and model selection:** Consumers can discover provider-prefixed model IDs and select them unchanged for OpenAI-compatible Chat Completions across provider families.
- **AIG-R02 Authentication and revocation:** Clients support explicit settings and the shared environment convention, protect bearer plaintext from diagnostic configuration, and send no Authorization header when no token is supplied. A gateway requires a distinct consumer bearer for protected operations and rejects a revoked bearer without invalidating another consumer's bearer.
- **AIG-R03 Streaming and usage:** Clients expose incremental chat output, request streaming usage, and retain supplied usage for chat and native decisions without fabricating missing counts.
- **AIG-R04 Backend neutrality:** Any gateway satisfying the public wire contract can serve clients without a gateway-specific SDK. Backend substitution preserves endpoint paths, authentication form, model identity, and application payload shape.

### Must preserve output semantics

- **AIG-R05 Structured-or-refuse:** Requested structured formatting reaches the selected provider through the gateway's documented schema adaptation or is refused; it never silently becomes unconstrained chat success.
- **AIG-R06 Original-schema validation:** Before returning a successful structured value, the client validates it locally against the caller's original schema, including constraints omitted from a provider projection or relaxed by the gateway. Invalid output remains a failure.
- **AIG-R07 Native decisions:** Consumers can batch named classification, probability, and rating decisions over schema-encoded input using explicit or environment settings and an optional model selection with a documented default. Answers are checked for required names, labels, ranges, and distributions, and supplied usage is retained.
- **AIG-R08 Probability integrity:** Native provider probability and confidence remain distinct. Ordinary chat classification is never presented as a calibrated native decision probability; invalid distributions are rejected rather than normalized into success.
- **AIG-R09 Gateway boundary:** Client libraries do not manage subscriptions, provider credentials, gateway authentication policy, or application HTTP/telemetry runtimes.

### Must expose operations and failures faithfully

- **AIG-R10 Failure visibility:** Authentication refusal, invalid payloads, unsupported schema modes, transport or upstream unavailability, provider rejection, in-stream errors after HTTP 200, and invalid outputs remain distinguishable failures. A partial stream is not a completed successful response.
- **AIG-R11 Tool calling:** Consumers can send tool definitions and prior tool results, receive tool-call IDs and arguments in ordinary and streaming chat, and continue the conversation without the client executing tools implicitly.
- **AIG-R12 GenAI telemetry:** Client realizations emit OpenTelemetry GenAI spans for chat, structured output, native decisions, and model tool-call exchanges, retaining supplied token usage and failure outcomes. A streaming span covers consumption through completion, error, or cancellation. Bearers and raw prompts, responses, and tool arguments are not emitted by default.
