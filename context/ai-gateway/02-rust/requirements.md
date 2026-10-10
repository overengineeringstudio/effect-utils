# Rust Client — Requirements

## Context

**Role:** The asynchronous Rust realization of the [public consumer contract](../requirements.md), using the [shared wire](../spec.md).
The foundation choice is recorded in [decision 0001](./.decisions/0001-async-openai-foundation.md).

## Assumptions

- **AIG.RS-A01 Foundation:** async-openai supplies Chat Completions and streaming transport; the wrapper owns the additional decision and discovery contracts.
- **AIG.RS-A02 Caller-owned execution:** Consumers supply an async runtime and their own retry, tool-execution, and telemetry-export policies.

## Acceptable Tradeoffs

- **AIG.RS-T01 No blocking facade:** Async-only access satisfies the public surface without a synchronous runtime bridge.
- **AIG.RS-T02 Provider projection:** A strict provider projection can narrow how a schema is expressed on the wire, but never substitutes for validation of the original schema.

## Requirements

### Must preserve transport and configuration semantics

- **AIG.RS-R01 Async foundation:** Use async-openai for asynchronous chat, SSE with usage, structured output, and tool-call exchange without requiring a blocking API. _refines: AIG-R01, AIG-R03, AIG-R11._
- **AIG.RS-R02 Explicit authentication:** Support explicit and environment URL/token settings, redact the token in diagnostics, and send no Authorization header when the token is absent. _refines: AIG-R02._
- **AIG.RS-R03 No hidden retries:** Disable client retries so one requested operation does not silently replay a provider call; retry policy belongs to the consumer. _refines: AIG-R09, AIG-R10._
- **AIG.RS-R04 Shared auxiliary wire:** Expose model discovery and native decisions using the foundation's BYOT transport instead of a second gateway-specific SDK or parallel HTTP stack. _refines: AIG-R01, AIG-R04, AIG-R07._
- **AIG.RS-R05 Portable TLS:** The supported transport uses rustls with ring rather than requiring platform-native TLS. _refines: AIG-R04, AIG-R09._

### Must preserve schema and decision semantics

- **AIG.RS-R06 Original-schema checking:** Derive the caller schema with schemars, send a strict-compatible projection when requested, and validate the decoded value with jsonschema against the unmodified original schema before typed decoding succeeds. _refines: AIG-R05, AIG-R06._
- **AIG.RS-R07 Checked native answers:** Encode named classify/probability/rate questions, use the documented decision-model default when omitted, and reject missing names, unknown labels, invalid ranges, and invalid distributions without a chat fallback. _refines: AIG-R07, AIG-R08._
- **AIG.RS-R08 Visible stream outcomes:** Preserve provider errors and usage, distinguish transport, HTTP, stream, and local-validation failures, and never convert partial output or an initial HTTP 200 into completed success. _refines: AIG-R03, AIG-R10._

### Must own semantic telemetry

- **AIG.RS-R09 Wrapper-owned GenAI spans:** The wrapper owns GenAI operation spans across chat, structured output, native decisions, and tool-call exchanges, including stream lifetime and supplied usage. Consumers own exporters; bearer and content capture are excluded by default. _refines: AIG-R09, AIG-R12._
