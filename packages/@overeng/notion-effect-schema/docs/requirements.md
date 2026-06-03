# Notion Effect Schema Requirements

## Context

These requirements define the Effect Schema layer for Notion API payloads. They
build on shared primitives from
[Notion core requirements](../../notion-core/docs/requirements.md).

## Assumptions

- **A01 Core primitives:** Dependency-free Notion constants, literal tuples,
  and helpers come from `@overeng/notion-core`.
- **A02 Effect dependency:** This package may depend on Effect and Effect Schema
  because schema decoding, encoding, transforms, and annotations are its primary
  purpose.

## Requirements

### Must Own Schema Contracts

- **R01 Wire schemas:** The package must expose Effect Schema definitions for
  supported Notion wire payloads.
- **R02 Schema facades:** The package must expose ergonomic schema helpers for
  common Notion property reads and writes.
- **R03 Schema metadata:** Schemas must preserve useful identifiers,
  descriptions, examples, and Notion documentation references.

### Must Preserve Sync-Safe Canonical Values

- **R04 Canonical values:** The package must own canonical property value
  schemas used for medium-independent sync projections.
- **R05 Canonical codecs:** Canonical property codecs must preserve byte-stable
  JSON layout for hashing and conflict detection.

### Must Keep Boundaries Clear

- **R06 Core reuse:** Shared pure literals and helpers must come from
  `@overeng/notion-core` when they do not require Effect Schema.
- **R07 No transport ownership:** The package must not own HTTP request
  execution, retries, rate limits, or token resolution.
- **R08 No local file-format ownership:** The package must not own `.nmd` file
  or sidecar contracts.
