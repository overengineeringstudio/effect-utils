# Decision 0003: Data-only conformance cases with local replay

Status: accepted

## Context

Effect, Rust, and edge realizations need common evidence for the public contract.
A shared executable fake gateway would couple that evidence to a runtime and
its transport implementation rather than to the consumer-observable wire.

## Evidence and Argument

The 2026-10-09 conformance decision q6 selects data-only JSON cases and
per-language replay. The naming decision q7 assigns the public package
`@overeng/ai-gateway-conformance`. A machine-readable schema makes the shared
inputs and expected outcomes inspectable without running another language's
harness.

## Options

| Option                                            | Tradeoff                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Data-only JSON cases with local replay (selected) | Shares contract evidence without a runtime dependency; each realization maintains its adapter. |
| Shared fake-gateway binary                        | Centralizes serving logic but adds a runtime and couples every replay to one implementation.   |
| Independent language fixtures                     | Keeps harnesses local but allows contract expectations to drift.                               |

## Decision

The package at `packages/@overeng/ai-gateway-conformance` owns
`case.schema.json` and one JSON file per case under `cases/`. Cases describe
request expectations, controlled HTTP/JSON/SSE responses, expected outcomes,
and the original caller schema where relevant. They contain no executable code.

The `01-effect`, `02-rust`, and `03-edge` realizations replay all shared cases using local
adapters. The [root specification](../spec.md#conformance-cases-aig-r01aig-r12)
defines the shared coverage and replay responsibilities; language-specific API
composition and harness implementation remain local.

## Consequences

Wire expectations change once in the public package. Every realization must
update its replay when the case contract changes. Shared cases do not replace
local tests for telemetry lifetime, cancellation, or other behavior that cannot
be expressed by the data-only request/response contract.
