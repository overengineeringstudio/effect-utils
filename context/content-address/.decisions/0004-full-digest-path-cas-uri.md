# Decision: CAS URIs carry the full digest-derived object path

## Status

Accepted.

## Context

CAS artifact records contain both a retrieval URI and a content descriptor. This is intentionally redundant if the URI includes the digest-derived path and the descriptor includes the digest.

Established CAS designs commonly keep lookup keys inspectable while still requiring verification from content identity and size metadata.

## Decision

`cas:` URIs carry the full digest-derived object path:

```text
cas:sha256/<first-byte-hex>/<remaining-31-bytes-hex>
```

The URI is the retrieval key. The descriptor is the authority for digest, byte length, media type, codec, and schema version. A resolver must fail if the URI path does not match the expected descriptor digest.

## Consequences

- Artifact links remain portable and inspectable.
- Manifests can list descriptors while product spans can carry direct retrieval URIs.
- Resolver implementations can detect URI/descriptor disagreement as an integrity error.
- Redundancy is accepted because URI and descriptor have different responsibilities.
