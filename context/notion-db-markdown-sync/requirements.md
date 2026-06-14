# Notion DB Markdown Sync Requirements

## Context

These requirements serve [vision.md](./vision.md). They define the long-term
constraints for composing NotionMD page files with Notion datasource sync local
workspaces.

## Assumptions

- **A01 NotionMD contract:** Page files build on the standalone NotionMD `.nmd`
  envelope and must remain valid NotionMD files.
- **A02 Datasource sync contract:** Bidirectional datasource safety builds on
  the datasource-sync planner, guard, outbox, conflict, and settlement model.
- **A03 Schema ownership:** Canonical Notion property values, descriptors,
  codecs, and write-class taxonomy are owned by
  `@overeng/notion-effect-schema`.

## Acceptable Tradeoffs

- **T01 Descriptor visibility:** `.nmd` files may carry compact property
  descriptors when they improve portability and diagnostics, but those
  descriptors are not sync-control proof.
- **T02 Progressive control plane:** Lightweight mirror modes may use less
  hidden state than shared bidirectional sync, as long as the reduced guarantee
  is explicit.
- **T03 Version-visible paths:** Public workspace paths may carry explicit
  namespace versions even when that makes paths slightly longer, because a
  clean incompatible future surface should get a new namespace instead of an
  implicit migration.

## Requirements

### Must Keep The User Surface Small

- **R01 Canonical user surfaces:** The intended user-editable surfaces must be
  limited to data files and `pages/**/*.nmd` page files.
- **R02 Hidden implementation state:** Bases, outbox state, leases, checkpoints,
  conflict internals, object state, and settlement evidence must live in hidden
  implementation state, not in the public data file or as page-adjacent user
  files.
- **R03 Standalone page validity:** Page files in datasource workspaces
  must remain valid standalone NotionMD `.nmd` files.
- **R04 Versioned workspace namespace:** Every durable local artifact that can
  outlive a command run must belong to an explicit workspace namespace version,
  either by path, file name, SQLite metadata, or frontmatter/schema identifier.
- **R05 Clean break only:** The system must expose only the v1 public surface:
  `pages` for SQL, versioned workspace paths, and hidden `.notion/v1` state.
  Unknown or mixed namespace versions must fail closed with explicit tracking
  guidance.

### Must Compose Local Representations

- **R06 Single local truth per surface:** SQLite and Markdown edits must be
  converged by stable page/property/body/lifecycle identity before remote write
  planning in shared mode.
- **R07 No competing authority modes:** Authority mode must be workspace-wide;
  data files and page files must not declare conflicting modes inside one
  workspace.
- **R08 Linked views are projections:** Linked views must not own writable
  files, schema, absence evidence, or remote write authority.

### Must Make Property Mutation Principled

- **R09 Shared property semantics:** NotionMD and datasource-sync must share
  canonical property values, descriptors, write payload codecs, and write-class
  taxonomy instead of duplicating property models.
- **R10 Descriptor boundary:** Property descriptors may identify which Notion
  property a visible field claims to edit, but they are one evidence source for
  stable property identity, not a required proof carrier. They must not be
  treated as freshness, base, relation-availability, convergence, outbox, or
  settlement proof.
- **R11 Proof-based mutation:** Datasource-scoped property writes must be
  accepted only when a proof provider can prove stable property identity,
  current schema/config consistency, writable write class, complete required
  base values, relation target availability when relevant, local-surface
  convergence when relevant, and mode-appropriate settlement guarantees.
- **R12 Entrypoint neutrality:** Mutation safety must be determined by the
  available proof, not by whether the command was invoked through NotionMD or
  datasource-sync.

### Must Fail Closed And Stay Observable

- **R13 Specific guards:** Missing or stale proof must fail closed with a named
  guard that identifies the missing invariant.
- **R14 Read-only unsupported values:** Computed, unsupported, incomplete,
  lossy, or ambiguous property values must not appear as ordinary writable
  fields.
- **R15 Dry-run for writes:** Every command that can write to Notion, the
  filesystem, SQLite data files, hidden implementation state, outbox, or
  settlement state must support dry-run planning without durable mutation. For
  watch-style commands, dry-run means observe and repeatedly report plans while
  suppressing durable local, hidden-state, outbox, settlement, and Notion
  writes.
