# Clean break for body identity

Status: accepted

Datasource-sync treats page-body bases as typed body identities rather than
generic hashes with optional evidence metadata. This deliberately breaks legacy
local store compatibility: old body projections must be re-established instead
of decoded through compatibility branches.

## Consequences

Remote body observations must produce evidence-backed identities, projection
payloads store body pointers as domain envelopes, and tests assert replay of
typed identities. The cost is a one-time local SQLite reset for users with old
body-sync stores.
