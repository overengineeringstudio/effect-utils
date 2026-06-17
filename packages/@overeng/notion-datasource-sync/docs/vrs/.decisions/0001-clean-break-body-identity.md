# Clean break for body identity

Status: accepted

Datasource-sync treats page-body bases as typed body identities rather than
generic hashes with optional evidence metadata. Stores with any other body
identity shape are not decoded by the current package; users establish a fresh
v1 workspace instead.

## Consequences

Remote body observations must produce evidence-backed identities, projection
payloads store body pointers as domain envelopes, and tests assert replay of
typed identities. The cost is that non-v1 local SQLite stores are outside the
supported workspace contract.
