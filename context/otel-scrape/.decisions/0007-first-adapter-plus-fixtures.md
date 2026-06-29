# Decision: prove one real adapter plus focused artifact fixtures

## Status

Accepted.

## Context

The classification ladder includes events, spans, metrics, and profile links. Requiring one first adapter to exercise every output kind in one real tool run would make adapter selection serve the test matrix more than the product.

`otel-scrape` also now depends on the reusable `content-address` VRS for CAS descriptors, `cas:` URIs, and manifest pins. That artifact lane can be proven with focused fixtures without pretending a first adapter naturally emits every profile shape.

## Decision

The first implementation proves:

- one real adapter path for structured tool output,
- wrapper-owned command and process spans,
- adapter-derived classification for the source shapes the adapter actually owns,
- focused CAS/profile fixtures for descriptor, `cas:` URI, resolver, and manifest-pin behavior.

The first real adapter does not need to emit events, spans, metrics, and profile links in one run.

## Consequences

- The vertical slice stays representative instead of being distorted around one all-purpose fixture tool.
- CAS/profile behavior remains testable at the artifact contract boundary.
- Later adapter additions can broaden ladder coverage without redefining the initial release proof.
