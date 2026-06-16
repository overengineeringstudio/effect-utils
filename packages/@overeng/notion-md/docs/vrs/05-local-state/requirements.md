# Requirements: 05-local-state

**Role.** The durable local state layer: the strict versioned `.nmd` envelope,
the page-id-keyed sync sidecar, the content-addressed `.notion-md/` object store,
and the volatile-URL exclusion that keeps local identity stable across pulls and
repository moves. The base snapshots the engine
([03-sync-engine](../03-sync-engine/requirements.md)) reads for guarded push and
three-way merge live here.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
writable projection captured into the envelope (page metadata, properties,
`schema_snapshot`) is owned by
[06-data-source](../06-data-source/requirements.md); the hosted-media
canonicalization that keeps stored URLs stable is owned by
[04-fidelity](../04-fidelity/requirements.md) (R36).

## Requirements

### Must Maintain Durable Local State

- **R06 Versioned state:** Local sync state must use explicit schema versions and reject unknown fields unless an extension models them.
- **R07 Content addressing:** Large or immutable artifacts must be stored by content hash rather than by transient Notion retrieval URL.
- **R08 Stable references:** Object-store refs must use relative paths plus content addresses that survive repository moves.
- **R10 Volatile URL exclusion:** Expiring Notion file URLs must not be durable local identifiers.
