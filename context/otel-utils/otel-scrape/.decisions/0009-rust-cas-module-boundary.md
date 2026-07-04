# Decision: Keep Rust CAS Conformance Wrapper-Local Until a Second Rust Consumer Exists

## Status

Accepted.

## Context

`context/content-address` owns the reusable CAS contract. The TypeScript package
`@overeng/content-address` is the first reusable implementation package. The
Rust `otel-scrape` artifact lane also needs descriptor, object-path, `cas:` URI,
manifest, and pin behavior to write profile artifacts without depending on a
Node runtime.

Making a public Rust CAS crate now would create an ownership surface before
there is a second Rust consumer. Leaving the implementation as ad hoc helpers in
`lib.rs` makes it too easy for the Rust writer slice to drift from the VRS.

## Decision

Factor the Rust artifact-lane CAS behavior into a private
`otel_scrape::content_address` module.

The module must:

- mirror the `context/content-address` descriptor, object path, `cas:` URI,
  manifest, and pin contract,
- carry conformance tests with fixed digest, URI, manifest, and pin-name vectors,
- remain private to `otel-scrape` until a second Rust consumer or generated
  cross-language contract justifies a crate boundary,
- keep `@overeng/content-address` as the reusable public implementation package.

## Consequences

This removes the local helper sprawl from `lib.rs` and gives Rust a named
contract boundary without prematurely creating a new package. The tradeoff is
that TypeScript and Rust still have separate implementations of the same CAS
contract. The conformance vectors are the guardrail until the contract is
generated or promoted into a shared Rust crate.
