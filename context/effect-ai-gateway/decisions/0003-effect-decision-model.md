# Use Effect Decision and DecisionModel

## Decision

Represent classification, probability, and rating through Effect `Decision` and `DecisionModel` backed by `@effect/ai-typesafe`, not a separate judgment service or a chat-derived probability adapter.

## Rationale

The existing Effect abstraction encodes input, infers answer labels, validates distributions, and exposes usage through a provider layer. A separate service would duplicate its question DSL, validation, error and layer contracts. Chat-generated labels cannot establish calibrated probability semantics.

## Consequences

Decision requests use the gateway's `/v1/systemone` route and may select a gateway-accessible decision model. The typed response includes validated answers and available usage, without inventing model provenance or probabilities when the provider does not supply them.
