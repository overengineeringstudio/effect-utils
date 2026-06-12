# Notion Markdown Sync — Glossary

This glossary defines the domain language for notion-md's sync model. It covers
the concepts used by the VRS and implementation; generic Effect, CLI, and
Markdown terms are intentionally omitted.

## Language

**Source**:
The frontmatter field that declares which sync mechanism and authority policy a
file uses. Valid values are `local`, `remote`, and `shared`.
_Avoid_: mode, direction flag

**Tracked Page**:
A Notion page bound to a local `.nmd` file through explicit frontmatter identity
and Source. Tracking is established by `track`.
_Avoid_: cloned page, imported page

**Mirror Sync**:
The stateless mechanism for pages authored on exactly one side. `source: local`
mirrors local content to Notion; `source: remote` mirrors Notion content to the
local file.
_Avoid_: single-source guarded sync, one-way merge

**Shared Sync**:
The stateful mechanism for pages authored on both sides. It uses a Base Snapshot
for three-way merge and emits conflict artifacts when concurrent edits cannot be
resolved.
_Avoid_: bidirectional mode, two-way sync

**Authority**:
The side that wins under Mirror Sync when the local and remote modeled body
differs. Local is authoritative for `source: local`; Notion is authoritative for
`source: remote`.
_Avoid_: winner flag, precedence

**Modeled Body**:
The Notion enhanced Markdown body surface that notion-md can render, compare,
and write with known fidelity. It excludes unsupported blocks, child pages,
comments, files, and local review metadata.
_Avoid_: whole page, all content

**Base Snapshot**:
The last clean body observation used by Shared Sync to distinguish local-only,
remote-only, and concurrent edits. Mirror Sync has no Base Snapshot.
_Avoid_: stored hash, checkpoint

**Semantic Equivalence**:
The relation used to decide whether local and remote bodies are in sync after
canonical normalization. It folds presentation-only differences while preserving
body-shape differences that affect Notion fidelity.
_Avoid_: byte equality, raw hash equality

## Flagged Ambiguities

**Single-source**:
Historically meant "author on one side" and sometimes implied guarded writes.
Use Mirror Sync when referring to the stateless authoritative mechanism.

**Bidirectional**:
Historically described any sync that can move data both ways. Use Shared Sync
when referring to the stateful base-and-merge mechanism for concurrent authoring.
