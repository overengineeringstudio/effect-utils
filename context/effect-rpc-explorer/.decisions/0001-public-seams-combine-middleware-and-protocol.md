# 0001 - Combine public middleware and Protocol seams

Status: accepted

## Context

A reusable explorer needs decoded request context, correlated terminal handler
outcomes, encoded stream traffic, acknowledgements, interruptions, send
failures, and connection faults. No single public Effect 4 seam supplies all of
those facts.

## Options

| Option                                            | Result   | Reason                                                                            |
| ------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| Middleware only                                   | Rejected | Does not observe chunks, Ack, Interrupt, or transport send facts.                 |
| Protocol only                                     | Rejected | Does not reliably provide decoded context or a correlated handler terminal Cause. |
| Combine public middleware and Protocol decorators | Selected | Covers complementary facts without private Effect imports.                        |

## Decision

Compose server middleware with transparent public client/server Protocol
decorators. Treat connection-level faults without request IDs as
connection-scoped uncertainty.

## Evidence and Argument

The disposable rc.115 probe observed that middleware supplies decoded context
and a correlated terminal Cause while Protocol traffic supplies chunks, Ack,
Interrupt, send outcomes, and uncorrelated connection faults. The selected
combination covers those complementary facts at supported public seams.

## Consequences

- Core composes server middleware and transparent client/server Protocol
  decorators; either alone is insufficient.
- Protocol decorators preserve every delegated capability and do not depend on
  private Effect files or internal stream helpers.
- Uncorrelated protocol faults remain connection-scoped and make active records
  uncertain rather than guessed request failures.
- Effect's unstable RPC surface is version-gated by public-seam compatibility
  evidence.
