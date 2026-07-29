# Decision: content-address uses a context-level VRS root

## Status

Accepted.

## Context

`otel-scrape` needs content-addressed profile artifact links, but the descriptor, store, resolver, and URI contract is reusable beyond one product system.

The repo already has `packages/@overeng/content-address`, which implements descriptor primitives. The durable system intent should be self-contained and composable so additional packages and languages can implement the same contract.

## Decision

Define `content-address` as a cross-cutting VRS root under `context/content-address/`.

`packages/@overeng/content-address` is the first implementation package, not the VRS owner. Product VRS documents such as `context/otel-utils/otel-scrape` reference this VRS for artifact identity and retrieval.

## Consequences

- The CAS contract is reusable without coupling all consumers to otel-scrape.
- Package-local implementation docs can stay close to code, while durable intent remains in `context/content-address`.
- Cross-language implementations can conform to the same descriptor, URI, store, and resolver semantics.
