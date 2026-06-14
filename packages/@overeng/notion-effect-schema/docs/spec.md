# Notion Effect Schema Spec

This document specifies `@overeng/notion-effect-schema`. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

This spec defines:

- Effect Schema ownership for Notion wire payloads,
- schema facades and property transforms,
- canonical property value and codec ownership,
- property descriptor and write-class semantics used by sync engines,
- dependency direction toward `@overeng/notion-core`.

It does not define:

- pure dependency-free primitives, owned by `@overeng/notion-core`,
- HTTP API services, owned by `@overeng/notion-effect-client`,
- `.nmd` file and sidecar contracts, owned by `@overeng/notion-md`,
- datasource sync persistence and reconciliation, owned by
  `@overeng/notion-datasource-sync`,
- authority modes, workspace convergence, outbox, conflict handling, or live
  proof acquisition.

## Layering

Requirement trace: R01-R10.

```
notion-core
  └── notion-effect-schema
        ├── common.ts              # schema annotations and primitive schemas
        ├── rich-text.ts           # rich text wire schemas
        ├── objects.ts             # page/block/database/data-source objects
        ├── property-schema.ts     # database property schema objects
        └── properties/
              ├── canonical.ts       # canonical property value schemas
              ├── canonical-codec.ts # canonical encode/decode effects
              └── *.ts               # property read/write transforms
```

`@overeng/notion-effect-schema` imports dependency-free tuples and helpers from
`@overeng/notion-core`, then wraps them in Effect Schema values where runtime
decoding, encoding, annotations, or transforms are required.

## Canonical Property Values

Requirement trace: R04-R06.

Canonical property values stay in this package because they are Effect Schema
values with byte-stable JSON encoding requirements. The sync packages may depend
on these schemas and codecs, but they must not duplicate the canonical property
union or write-class taxonomy.

## Property Mutation Semantics

Requirement trace: R04-R06, R10.

This package owns the property-level facts that every sync surface must share:

- branded property and page identity schemas,
- branded data-source identity schemas when property descriptors need to cross
  package boundaries,
- canonical property value schemas,
- property write payload schemas and codecs,
- property schema/config descriptors,
- write-class classification for writable, computed, and unsupported property
  types,
- pure consistency checks between a canonical value and a Notion property
  schema/configuration.

It does not decide whether a particular write is allowed at runtime. Runtime
write safety depends on evidence owned by higher layers: authority mode,
freshness, page-property completeness, relation target availability,
local-surface convergence, durable outbox state, conflicts, and settlement.

The intended dependency direction is:

```text
notion-effect-schema
  property values / descriptors / codecs / write classes
        |
        v
notion-md and notion-datasource-sync
  proof providers and mutation guards
```

This keeps property semantics uniform across standalone `.nmd` sync and
datasource workspaces without turning the schema package into a sync engine.
