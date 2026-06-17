# Keep the public SQLite data file separate from the hidden control plane

Status: accepted

The user-facing SQLite surface should be `data/v1/<source>.sqlite`, containing only stable
public tables/views. Private event logs, outbox state, leases, base hashes,
checkpoints, object state, repair metadata, and implementation projections live
under hidden `.notion/v1/` implementation state instead of private `_nds_*` tables
inside the public data file.

This gives users and agents a cleaner rule: data files and `pages/v1/**/*.nmd` are
the intended surfaces; `.notion/v1/**` is tool state. It sacrifices the earlier
self-contained single-SQLite-file replica property, but removes a major
footgun and lets implementation storage evolve without changing the public SQL
API.
