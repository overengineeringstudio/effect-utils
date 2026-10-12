# 0001 — effect-utils owns the public otel-scrape contract

Status: accepted

## Context

The design needs a public, reusable home because it relies on effect-utils packages for typed OTEL values, command helpers, and content-addressed artifact descriptors.

## Decision

The public VRS and package-facing contract live in effect-utils under `context/otel-scrape/`. Any implementation must conform to effect-utils-owned contracts first:

- `@overeng/otel-contract` for typed telemetry values.
- `@overeng/content-address` for artifact identity and descriptor conventions.
- Existing effect-utils command/telemetry helpers where they satisfy the wrapper contract.

Private deployment topology, machine names, and downstream consumer details are not part of this public contract.

## Consequences

- The issue tracker for implementation is effect-utils.
- Downstream repositories can reference the public contract without copying private design context.
- Package boundaries are resolved by [0003-rust-package-boundary.md](./0003-rust-package-boundary.md).

## Evidence and Argument

The context and consequences above supply this record's rationale; this shape
normalization adds no new implementation evidence or historical deliberation.

## Options

| Recorded design state                 | Disposition                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Decision stated above                 | Accepted in the original record                                             |
| Prior limitation described in Context | Contrasted by the original rationale; no additional historical option claim |
