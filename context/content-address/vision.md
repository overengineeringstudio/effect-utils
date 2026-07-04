# Vision: content-address

Content-addressed artifacts in effect-utils have one reusable contract for identity, storage, and retrieval.

The system lets tools emit compact, location-independent references to large or structured artifacts while keeping the bytes outside telemetry payloads, logs, and span attributes. A reference must be verifiable from the bytes it names, portable across local and CI environments, and safe to resolve without trusting the producer.

`content-address` is a composable VRS root. Product systems such as `otel-scrape` depend on it for artifact identity and retrieval instead of defining their own artifact lanes.

## Direction

- Content identity is derived from bytes, not from where bytes were written.
- Descriptors are the stable semantic contract; stores and resolvers are interchangeable implementations of that contract.
- Content-addressed blobs are separate from roots, refs, pins, and product-specific indexes.
- Resolution is fail-closed: readers verify digest and byte length before using bytes.
- The contract stays small enough to implement in Rust, TypeScript, and shell-adjacent tooling.
- Local and CI workflows use the same artifact identity even when their transport differs.
