# Notion Core Spec

This document specifies `@overeng/notion-core`. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

This spec defines:

- the dependency-free primitive boundary,
- exported Notion constants and helper families,
- package relationships with schema and client packages.

It does not define:

- Effect Schema wire contracts, owned by `@overeng/notion-effect-schema`,
- HTTP API services, owned by `@overeng/notion-effect-client`,
- `.nmd` file and sidecar contracts, owned by `@overeng/notion-md`,
- datasource sync persistence, outbox, or replica behavior, owned by
  `@overeng/notion-datasource-sync`.

## Package Boundary

Requirement trace: R01-R06.

```
notion-core
├── constants.ts    # API/docs constants and version helpers
├── ids.ts          # Notion UUID helpers
├── colors.ts       # color tuples, types, guards
├── properties.ts   # property type/write-class tuples, types, classifier
└── rich-text.ts    # raw rich-text plain-text helper
```

`@overeng/notion-core` exports only plain TypeScript values and types. It has no
runtime dependency on Effect or package-specific services.

## Package Relationships

| Package                           | Relationship to core                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `@overeng/notion-effect-schema`   | Builds Effect Schema literals and helpers from core primitives. |
| `@overeng/notion-effect-client`   | Re-exports shared API constants while owning HTTP services.     |
| `@overeng/notion-md`              | Owns `.nmd` contracts and body sync.                            |
| `@overeng/notion-datasource-sync` | Owns sync persistence and reconciliation.                       |
| `@overeng/notion-react`           | Owns React integration surfaces.                                |
| `@overeng/notion-cli`             | Owns user-facing command composition.                           |
