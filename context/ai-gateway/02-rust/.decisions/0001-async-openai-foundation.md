# Decision 0001: Build on async-openai

Status: accepted

## Context

The Rust client needs the public chat/SSE, structured-output, native-decision,
tool-call, model-discovery, and GenAI telemetry surface without inventing a new
provider framework. A blocking facade is not required.

## Evidence and Argument

The 2026-10-09 Rust foundation research and offline gateway bakeoff compared
async-openai 0.42.1, genai 0.6.5, and rig 0.44.0 using the same recording fake
wire. The bakeoff covered chat, SSE usage, an in-stream error, valid/invalid
structured output, native decisions, tools, and HTTP failures. All candidates
handled the eight scenarios once wrapper gaps were addressed; original-schema
validation rejected the invalid fixture. Recorded requests established one hit
for error scenarios with retries disabled and no Authorization without a token.
These are offline results, not authenticated live-gateway proof.

async-openai preserved response model IDs and explicit cached-token zeroes and
reached `/v1/models` and `/v1/systemone` through one BYOT client. Its default
catalog type requires `created`, which the gateway can omit. Its defaults also
retry failures, send an empty bearer without custom configuration, and lose raw
4xx bodies. The prototype addressed these through custom Config, a plain
transport service, and error-body middleware. It supplied wrapper-owned GenAI
spans and was built and run using rustls with ring.

Evidence citations: *Rust AI landscape*, *Rust LLM foundations: research step*,
and *Rust AI gateway bakeoff*, all dated 2026-10-09. They are internal research
records; only the public-safe conclusions above are reproduced. Foundation
selection: decision q2, record `evlo3v`. Capability selection: q28. These opaque
record identifiers are provenance, not public URLs or deployment coordinates.

## Options

| Option | Tradeoff |
| --- | --- |
| async-openai (selected) | Best wire fidelity and one BYOT client; custom auth, retry replacement, error preservation, local validation, and semantic telemetry are required. |
| genai | Good native error fidelity and no hidden retries, but stable telemetry is absent and the prototype loses stream model/cached-zero fidelity; native decisions need separate request code. |
| rig | Existing agent/tool machinery and native spans, but a larger framework surface, higher MSRV/release churn, and telemetry corrections exceed a thin client's needs. |
| Plain HTTP/SSE | Fewer SDK constraints but duplicates chat types, streaming decoding, and provider-compatible transport already supplied by async-openai. |

## Decision

Compose async-openai rather than implementing a new chat transport or adopting
an agent framework. Keep retries disabled, omit Authorization without a token,
use BYOT for gateway catalog/native decisions, validate the original schemars
schema with jsonschema, own semantic GenAI spans in the wrapper, and select
rustls with ring.

## Consequences

The wrapper owns the gateway-specific correctness gaps, not provider routing
or credential custody. [The specification](../spec.md) defines this boundary.
Crate name/path remain TBD; publishing an API does not follow from the offline
bakeoff alone. Prototype size/build timings are not a production performance
claim or a shared public conformance fixture set.
