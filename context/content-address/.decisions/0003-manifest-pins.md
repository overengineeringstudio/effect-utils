# Decision: use manifest pins as retention roots

## Status

Accepted.

## Context

Content-addressed blob presence is not retention intent. Established CAS systems separate immutable blobs from roots, refs, manifests, action records, or pins that provide lookup and reachability.

`otel-scrape` needs to retain all profile artifacts for one run without pinning each span link as a lifecycle policy.

## Decision

The first store implementation includes manifest pins.

A manifest is itself content-addressed. It lists descriptors that belong to a logical bundle, such as one `otel-scrape` run. A pin retains a manifest descriptor. Garbage collection roots are pinned manifest descriptors, and reachability walks through manifest contents.

Direct blob pins are not the primary model. They may be added later for administrative repair or debugging, but product systems should prefer manifest pins.

## Consequences

- A run or bundle has one lifecycle root while individual artifacts keep their own `cas:` retrieval URIs.
- Garbage collection can be specified as reachability from pinned manifests.
- Product systems can model artifact bundles without changing blob identity.
- The implementation must define a manifest schema before exposing destructive garbage collection.
