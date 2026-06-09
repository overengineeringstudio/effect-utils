# Notion Core Spec

This document specifies `@overeng/notion-core`. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

This spec defines:

- the dependency-free primitive boundary,
- exported Notion constants and helper families,
- body completeness and fidelity vocabulary,
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
├── body-fidelity.ts # body completeness vocabulary and pure classifiers
└── rich-text.ts    # raw rich-text plain-text helper
```

`@overeng/notion-core` exports only plain TypeScript values and types. It has no
runtime dependency on Effect or package-specific services.

## Body Fidelity

Requirement trace: R01-R06.

`@overeng/notion-core` owns the shared, dependency-free vocabulary for whether a
Notion page-body observation is safe to adopt as a clean Markdown base.

| Concept                    | Owner                  | Meaning                                                               |
| -------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `BodyCompleteness`         | `@overeng/notion-core` | Complete or lossy body evidence.                                      |
| `BodyLossyReason`          | `@overeng/notion-core` | Stable reason enum for blocked adoption/write policy.                 |
| `MarkdownBodySnapshot`     | `@overeng/notion-core` | Markdown endpoint output reduced to fidelity-relevant fields.         |
| `BlockInventory`           | `@overeng/notion-core` | Renderer/block-tree evidence used to classify endpoint completeness.  |
| `classifyBodyCompleteness` | `@overeng/notion-core` | Pure classifier with no Notion API, Effect, or filesystem dependency. |

The classifier is intentionally conservative. A body observation is lossy when
the Markdown endpoint reports truncation, reports unknown block IDs, the block
inventory contains unsupported entries, rendered block-tree evidence is required
but unavailable, or the independently rendered block tree proves the endpoint
Markdown has an unobserved suffix. That last case covers the known divider
truncation failure where single-page establishment previously treated a prefix
as a clean `.nmd` base.

Core does not fetch Notion data, render Markdown from blocks, write `.nmd`
files, or decide whether a particular caller may proceed. Those policies belong
to the packages above it.

## Package Relationships

| Package                           | Relationship to core                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@overeng/notion-effect-schema`   | Builds Effect Schema literals and helpers from core primitives.                                |
| `@overeng/notion-effect-client`   | Re-exports shared API constants and performs live body observation while owning HTTP services. |
| `@overeng/notion-md`              | Owns `.nmd` contracts, clean-base policy, and body sync.                                       |
| `@overeng/notion-datasource-sync` | Maps body completeness into planner/body guards.                                               |
| `@overeng/notion-react`           | Owns React integration surfaces; not a Markdown-adoption authority.                            |
| `@overeng/notion-cli`             | Owns user-facing command composition.                                                          |
