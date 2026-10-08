# Cache Descriptor Contract Requirements

This subsystem owns protocol descriptors and refines BUILD-R04. Consumer cache
policy owns authorization and service realization; a descriptor grants no permission.

## Assumptions

- **BUILD.CACHE-A01 Producer ownership:** Producers own credential-free descriptors.

## Acceptable Tradeoffs

- **BUILD.CACHE-T01 Rebuildable state:** Cache loss costs cold execution, not
  loss of a source of record.

## Requirements

- **BUILD.CACHE-R01 Single descriptor (refines BUILD-R04):** TypeScript and Nix
  readers validate the same producer-owned descriptor revision. Consumers compose
  exports rather than copying endpoint or signing identity.
- **BUILD.CACHE-R02 Tagged protocol:** Protocol kind and public/private visibility
  are independent; only fields belonging to the selected protocol are accepted.
- **BUILD.CACHE-R03 Fail-closed composition:** Missing/unknown fields, unsupported
  versions, invalid URIs, duplicate identities and conflicting declarations fail.
- **BUILD.CACHE-R04 No credentials:** Descriptors contain no credential values,
  private principal selection, or service topology.
- **BUILD.CACHE-R05 Client initialization:** RE client configuration is present
  before daemon startup, with all required addresses and explicit digest semantics.
