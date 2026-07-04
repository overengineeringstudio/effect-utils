# Requirements: content-address

## Identity

- The system must identify artifact bytes by cryptographic digest and byte length.
- The first supported digest algorithm is SHA-256.
- Descriptors must include media type and may include codec and schema version.
- Canonical JSON descriptors must be stable across object key insertion order.

## Storage

- Object storage must use a deterministic path derived from the digest.
- Storage implementations must deduplicate identical bytes.
- Writes must not expose partially written objects as complete objects.
- The contract must support a filesystem-backed store for local and CI use.
- Object storage must not treat blob presence as retention intent.
- Roots, refs, pins, manifests, and product indexes must be modeled separately from content-addressed blobs.

## Resolution

- Artifact references must be location-independent.
- A resolver must map a reference to bytes using an explicit store root or transport context.
- A resolver must verify descriptor digest and byte length before returning bytes to consumers.
- Missing objects, digest mismatches, byte-length mismatches, and unsupported algorithms must be distinct failures.

## Composition

- Systems that emit artifact references must depend on this VRS for descriptor, URI, store, and resolver semantics.
- Product VRS documents may specialize artifact roles and media types, but must not redefine the content-addressing contract.
- The first implementation package is `@overeng/content-address`; other language implementations must conform to this VRS.
- The design must stay aligned with established CAS systems by keeping canonical identity, blob storage, lookup roots, and retention pins as separate concepts.

## Retention

- The system must define a pinning model before adding garbage collection.
- Pins must be explicit retention roots, not implicit side effects of resolving or reading a blob.
- The primary pin target must be a manifest descriptor, not each individual artifact blob.
- Garbage collection must only remove objects unreachable from the configured pin/root set.

## Security And Privacy

- Artifact references must not require local absolute paths, credentials, or private source text in telemetry attributes.
- Resolvers must prevent path traversal outside the configured store root.
- Digest algorithms and URI schemes must be allowlisted.
