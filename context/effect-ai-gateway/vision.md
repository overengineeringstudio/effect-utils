# Effect AI Gateway — Vision

## The Problem

1. **Problem 1:** Applications using subscription-backed models need a shared, predictable way to call different model families without embedding provider-specific access logic.
2. **Problem 2:** An apparent structured answer can conceal unsupported formatting constraints; consumers need failures to remain visible rather than mistaking unconstrained text for validated output.
3. **Problem 3:** Categorical and probabilistic decisions need typed answers and honest probability semantics rather than ad hoc text classification.

## The Vision

- Applications use one gateway-facing integration across model families, addressing Problem 1.
- Consumers can distinguish validated structured output from rejected or invalid output, addressing Problem 2.
- Consumers express decisions once and receive typed answers with explicit probability semantics, addressing Problem 3.

## What This Is Not

- Not a subscription manager, gateway server, or provider credential store.
- Not a promise that every model supports every structured schema.
- Not a way to infer calibrated probabilities from ordinary chat responses.

## Success Criteria

1. One consumer integration can select provider-prefixed models from different model families without changing its chat API.
2. A request for structured output either produces a schema-valid value or reports failure; constraints are never silently ignored.
3. A consumer can request a batch of typed decisions and receive checked answers and available usage without a separate judgment service.
