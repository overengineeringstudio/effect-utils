# Effect AI Gateway — Requirements

## Context

This document refines [the vision](./vision.md) for a backend-neutral Effect AI integration. [The specification](./spec.md) defines its implementation.

## Assumptions

- **A01 Compatible gateway:** A gateway exposes OpenAI-compatible Chat Completions and model discovery, and exposes the TypeSafe decision endpoint when decision models are used.
- **A02 Caller-owned transport:** Consumers provide an Effect HTTP client and select gateway-accessible model IDs.

## Acceptable Tradeoffs

- **T01 Model-dependent formatting:** A gateway or model may reject a requested structured-output schema rather than translate it into a weaker guarantee.
- **T02 Optional usage:** Token usage is reported when the gateway supplies it; absent usage is not fabricated.

## Requirements

### Must support shared model access

- **R01 Model selection:** A consumer can select provider-prefixed model IDs without provider-specific chat integration.
- **R02 Authentication:** Explicit connection settings and environment-based settings both support a bearer token without exposing its plaintext in configuration values.
- **R03 Streaming:** Streaming chat requests request usage, and supplied usage is available to consumers.
- **R04 Backend neutrality:** Any gateway satisfying the documented wire contract can supply chat and decision models without a gateway-specific SDK.

### Must preserve output semantics

- **R05 Structured output:** Requested structured formatting is enforced and validated or rejected; unsupported constraints are never silently discarded.
- **R06 Decision answers:** Consumers can define schema-encoded input and named classification, probability, and rating decisions, receiving typed, validated answers and available usage.
- **R07 Probability integrity:** Ordinary chat classification is not presented as a calibrated decision probability.

### Must separate responsibilities

- **R08 Gateway boundary:** This package does not manage subscriptions, provider credentials, gateway authentication policy, or the HTTP runtime.
