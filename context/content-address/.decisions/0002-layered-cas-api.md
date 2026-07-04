# Decision: expose a layered CAS API

## Status

Accepted.

## Context

The existing `@overeng/content-address` implementation already provides descriptor primitives: SHA-256 digests, canonical JSON hashing, content descriptors, descriptor verification, and digest-derived object paths.

`otel-scrape` needs more than descriptors. It needs a reusable way to write profile bytes, emit location-independent references, and resolve those references later in local and CI environments.

## Decision

Expose the content-address implementation as layered modules:

- descriptors,
- object paths,
- filesystem-backed object store,
- resolver.

The layers are reusable independently, but the high-level store and resolver must compose them without redefining identity semantics.

## Consequences

- Existing descriptor behavior remains the base contract.
- Product systems such as `otel-scrape` can use store/resolver APIs instead of manually deriving paths.
- Rust and TypeScript implementations can share the same VRS hierarchy even if their module boundaries differ.
- Tests can target each layer independently while still proving end-to-end artifact resolution.
