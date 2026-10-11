# Decision 0002: Use Effect Decision and DecisionModel

Status: accepted

## Context

Typed classification, probability, and rating need native answer semantics and
schema-encoded input, not a separate application-owned judgment service.

## Evidence and Argument

Effect's existing abstraction encodes input, infers answer labels, validates
distributions, and exposes usage through its provider layer. A parallel service
would duplicate its question DSL, validation, error, and layer contracts.
Chat-generated labels cannot establish calibrated probability semantics.

## Options

| Option | Tradeoff |
| --- | --- |
| Effect Decision/DecisionModel (selected) | Reuses the validated typed abstraction and native TypeSafe provider. |
| Separate typed judgment service | Duplicates the existing abstraction and question definitions. |
| Chat-derived probability adapter | Cannot establish the required native calibration semantics. |

## Decision

Represent classification, probability, and rating through Effect `Decision`
and `DecisionModel` backed by `@effect/ai-typesafe`, not a parallel judgment
service or chat-derived probability adapter.

## Consequences

Use the parent's `/v1/systemone` operation and gateway-accessible decision IDs.
Return validated answers and supplied usage, without inventing provenance or
probabilities. [The Effect specification](../spec.md) owns the layer API.
