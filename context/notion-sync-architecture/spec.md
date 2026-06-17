# Spec - Notion Sync Architecture

This document specifies the stack-wide hierarchy, ownership boundaries, and
shared contract vocabulary for Notion sync systems in this repository. It builds
on [requirements.md](./requirements.md).

## Status

Draft. This tree is the canonical VRS root for stack-wide Notion sync
architecture.

## Scope

It does not define a shared sync engine, replace package VRS docs, or make React
part of the datasource Markdown workspace.

## Hierarchy

```text
context/notion-sync-architecture/
  intuition.md
  vision.md
  requirements.md
  spec.md
  glossary.md
  .decisions/

  01-shared-sync-contract/
    intuition.md
    requirements.md
    spec.md
    .decisions/

  02-realizations/
    intuition.md
    requirements.md
    spec.md
    .decisions/

    01-datasource-markdown-workspace/
      intuition.md
      requirements.md
      spec.md
      glossary.md
      .decisions/

      01-datasource-control-plane/
        intuition.md
        requirements.md
        spec.md
        .decisions/

      02-nmd-page-surface/
        intuition.md
        requirements.md
        spec.md
        .decisions/

    02-react-owned-region/
      intuition.md
      requirements.md
      spec.md
      .decisions/

  03-verification-and-evidence/
    intuition.md
    requirements.md
    spec.md
    .decisions/
```

## Package Relationship

Package VRS documents refine this stack VRS:

- `packages/@overeng/notion-datasource-sync/docs/vrs/` refines the datasource
  control-plane and workspace realization contracts.
- `packages/@overeng/notion-md/docs/vrs/` refines the `.nmd` page surface and
  standalone NotionMD contracts.
- `packages/@overeng/notion-react/docs/vrs/` refines the React owned-region
  realization contract.
- `@overeng/notion-effect-schema`, `@overeng/notion-effect-client`,
  `@overeng/notion-core`, and `@overeng/notion-property-write` provide lower
  level schema, client, body, and write helpers. They may be referenced by this
  VRS when their contracts become stack-wide.

## Shared Contract Vocabulary

The shared sync contract may define:

- surface identity,
- digest spaces,
- base, desired, and observed snapshots,
- checkpoints,
- guard, drift, conflict, and fallback outcomes,
- mutation command envelopes,
- apply results,
- proof and evidence shapes,
- telemetry/event names for verification.

It must not assume one storage engine, planner, renderer, cache, body adapter,
or Notion gateway.

## Realization Rule

Each realization must say which shared terms it refines and which semantics are
local. A realization may use package-local mechanisms when its authority model
differs from another realization.

Empty `.decisions/` directories are not committed; they are created lazily when a
node records its first hard-to-reverse decision.

## Decision Logs

Live VRS decision records use dot-prefixed `.decisions/` directories. A visible
`decisions/` directory inside this stack is legacy or non-canonical.
