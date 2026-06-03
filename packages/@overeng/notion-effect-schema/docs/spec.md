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
- dependency direction toward `@overeng/notion-core`.

It does not define:

- pure dependency-free primitives, owned by `@overeng/notion-core`,
- HTTP API services, owned by `@overeng/notion-effect-client`,
- `.nmd` file and sidecar contracts, owned by `@overeng/notion-md`,
- datasource sync persistence and reconciliation, owned by
  `@overeng/notion-datasource-sync`.

## Layering

Requirement trace: R01-R08.

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

Requirement trace: R04-R05.

Canonical property values stay in this package because they are Effect Schema
values with byte-stable JSON encoding requirements. The sync packages may depend
on these schemas and codecs, but they must not duplicate the canonical property
union or write-class taxonomy.
