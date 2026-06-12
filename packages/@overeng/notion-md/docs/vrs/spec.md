# Notion Markdown Sync Spec

This document specifies the Notion Markdown sync system. It builds on [requirements.md](./requirements.md).

## Status

Active for the implemented v-next sync core. `@overeng/notion-md` covers the
`track` / `status` / `sync` CLI, strict `.nmd` frontmatter, source-dispatched
Mirror Sync and Shared Sync, content-addressed local state, guarded
sync/watch behavior, batch multi-file and recursive folder orchestration,
Effect Platform file watching, dry-run planning for write commands, and live
Notion E2E coverage. File bytes, comment projection, webhook delivery, and full
data-source sync remain designed surfaces outside the implemented core. Full
data-source sync is owned by the standalone [Notion datasource sync
spec](../../../notion-datasource-sync/docs/vrs/spec.md).

## V-next sync model: frictionless, progressively-disclosed sync

This section is the normative implemented sync model. The bake-off record below
is preserved as the auditable evidence trail for the decision, while later
sections describe the supporting local format, service boundaries, watch
orchestration, and remaining designed surfaces.

Traces requirements [R09](./requirements.md), [R11](./requirements.md), and
[R30–R36](./requirements.md).

### North star

Make notion-md frictionless: the common single-source path (author on one side,
mirror to the other) pays _zero_ stored-state complexity; bidirectional power is
opt-in and progressively disclosed. The engine dispatches on self-describing
files, not on CLI flags.

### Decided surface (bake-off outcome)

The decided surface is three single-purpose, near-flagless verbs:
`track` / `status` / `sync`. Direction
and identity live in each file's frontmatter, not in flags (R34).

| Verb                     | Argument             | Behavior                                                                                                                                                                               |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `track <id\|url> [path]` | a Notion page id/url | The ONLY command taking a page id. Establishes a local tracked file/subtree for an existing Notion page. Writes self-describing frontmatter (`page_id`, `parent`, `source`).           |
| `status <path...>`       | local paths          | Read-only, **safe by construction** (no write path in its call graph). Reports the live in-sync decision per file in git-porcelain vocabulary; never mutates.                          |
| `sync <path...>`         | local paths          | Reconciles self-describing files; dispatches per file on frontmatter `source`, never on flags/arity. Creates remote pages for unbound local files. Always moves a file toward in-sync. |

#### `track <id|url> [path]`

Establishes tracking for an existing Notion page by materializing a local
file/subtree and writing self-describing frontmatter (`page_id`, `parent`,
`source`).

- `--as local|remote|shared` — default `remote` (you tracked existing Notion state).
- `--dry-run` — read and validate the remote page, report the intended output,
  and write nothing.
- Fail-closed on lossy remote observation: no clean base from a truncated or
  lossy body.
- Refuses to overwrite an existing file bound to a different page.

#### `status <path...>`

Read-only and safe by construction — the apply tail is unreachable from
`status` (no write path in its call graph). `status` is the overview preview for
one or more local file or directory targets.

`status` is optional preview, not a prerequisite for `sync`. Write commands also
support `--dry-run` for execution-local planning without mutation. Mirror Sync
does not record a "last previewed" marker, and watch mode cannot depend on
manual preview.

- Targets are explicit local paths. A directory target without `--recursive`
  uses the directory-tree status path; `--recursive` / `--concurrency` select
  flat batch discovery of existing `.nmd` files.
- Per file reports the live in-sync decision in git-porcelain vocabulary:
  `in-sync` / `local-ahead` (would push) / `remote-ahead` (would pull) /
  `diverged` (shared only) / `unbound` (would create).
- `--json` for machine output.

#### `sync <path...>`

Reconciles self-describing files. Dispatch is per file on frontmatter `source`,
never on flags or argument arity. Common-path flags: zero.

Local-first creation is part of `sync`: an unbound `source: local` file creates
a new remote page and records the returned `page_id`. Existing remote pages are
adopted with `track`, not with `sync`.

| Flag                 | Effect                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--watch`            | Continuous reconcile loop.                                                                                                                                                         |
| `--poll-interval-ms` | Remote poll cadence under `--watch`.                                                                                                                                               |
| `--recursive`        | Discover existing `.nmd` files under directory targets.                                                                                                                            |
| `--concurrency`      | Bounded per-file parallelism for trees.                                                                                                                                            |
| `--dry-run`          | Plan and validate the selected write operation without mutating Notion, local files, or local sync state.                                                                          |
| `--force`            | ONLY overrides a `shared` 3-way-merge divergence. Hard error / inert on single-source — single-source push already refuses on remote drift, so there is no single-source override. |
| `--json`             | Machine-readable one-shot output where supported.                                                                                                                                  |

R12/R13 destructive modes are not exposed as v-next CLI flags until the
destructive surface-specific semantics are implemented. The implemented core
fails closed on unsupported destructive body writes and unresolved review
markup.

Dropped from the pre-v-next surface, all subsumed by frontmatter dispatch: `clone`,
`--from-remote`, `--root`, `--root-file`, the two-arg `sync`, the separate
`plan` verb (folded into `status`), and file-vs-tree flag branching.

These are removed from the command tree, not retained as deprecated aliases or
migration-error branches. The v-next CLI teaches the new model through help text,
`status`, and self-describing files instead of preserving old surface area.

#### Git-native framing

`track` / `status` / `sync` keep one target grammar: `track` takes Notion page
ids or URLs, while `status` and `sync` take local paths. There is deliberately
**no `push` / `pull` verb**: direction lives
in each file's `source` — the per-file upstream-tracking config, analogous to
git's `branch.<x>.remote`. `status` and `sync` surface the one-line explainer:

> no push/pull — direction is each file's `source`; `sync` always moves toward
> in-sync, `source` decides which way.

git's staging, commits, and branches are rejected entirely — there is no `add`,
`commit`, `log`, or heuristic `sync <page-url>` form.

The machine-readable status vocabulary stays small and stable:
`in-sync`, `local-ahead`, `remote-ahead`, `diverged`, `unbound`. Human output
adds the consequence of the declared authority when a single-source file differs:
`local-ahead` means `sync` will overwrite Notion; `remote-ahead` means `sync`
will overwrite the local body. This is presentation, not another reconcile mode:
the core state model remains the table below.

#### `sync` dispatch table (per file)

The action is decided per file from `source`, the presence of `page_id`, and a
live compare (R33). Wrong-direction push is **structurally impossible** (R30):
direction is the file's `source`, so a `remote` file has no push branch and a
`local` file's write is the declared mirror operation, never a flag-decided
clobber.

| `source` | `page_id`   | live compare (R33)  | action                                                  |
| -------- | ----------- | ------------------- | ------------------------------------------------------- |
| local    | null/absent | —                   | create remote page under `parent`, write `page_id` back |
| local    | set         | equivalent          | noop                                                    |
| local    | set         | local ≢ remote      | push (mirror local → remote)                            |
| remote   | set         | equivalent          | noop                                                    |
| remote   | set         | local ≢ remote      | pull (mirror remote → local body)                       |
| remote   | absent      | —                   | error (a remote-tracked file must carry `page_id`)      |
| shared   | set         | 3-way merge vs base | noop / merge / `conflict.roughdraft`                    |
| shared   | absent      | —                   | error (`shared` requires an established `page_id`)      |

> **Statelessness boundary (R31/R32).** Single-source pages carry no stored base,
> so the engine cannot distinguish "I edited locally" from "the other side moved"
> — both present as `local ≢ remote`. The declared `source` therefore decides the
> winner unconditionally: `local` is authoritative (a `local` page silently
> mirrors over any remote drift), `remote` is authoritative (a `remote` page
> silently refreshes the local mirror, discarding stray local edits — recoverable
> from git). **Concurrent-edit _detection and refusal_ is exclusively the
> `source: shared` story** — it is the one mode with a stored base able to tell
> the two cases apart, and is the safety net a user opts into when both sides
> genuinely author. Attempting drift-refusal for single-source would require the
> very stored marker R31 forbids (and that caused the poisoned-`noop`).

#### Frontmatter schema (one file shape for all three `source` values)

`notion_md` carries `version`, `api_version`, `object`,
`source: 'local'|'remote'|'shared'` (required), `page_id: NotionId | null`
(null/absent ⇒ unbound ⇒ create-on-push, legal ONLY for `source: local`),
`url?`, `parent: ParentRef`, `page: PageState`, and `properties`.

Missing `source` is a schema error for v-next files. `track` may default
`--as remote` at the command boundary, but it writes the selected source
explicitly into the file.

**Schema-gated statelessness.** Single-source files (`source: local|remote`)
carry NO base/hash/last-pulled fields and NO `.notion-md/` sidecar entry. A
`shared` base is referenced only via the page-id-keyed sidecar
`.notion-md/sync/<page_id>.json` (an `object_ref` to a content-addressed
`base_snapshot`). The schema REJECTS a base on a non-`shared` file and REQUIRES
one for a bound `shared` file — single-source statelessness (R31) is a
structural/type property, not convention. `source: remote|shared` with no
`page_id` is a decode error.

### Internal layering

```
sync <path...>  /  status <path...>
      |
      v
Tree orchestration                  maps the per-page core over each file
      |                             (target discovery file|dir, dup page-id preflight,
      |                             bounded concurrency, per-file result aggregation).
      |                             Direction-agnostic.
      v
Per-page reconcile core (stateless) render(local) <-> read(current remote),
      |                             canonical-normalize both (R33), decide
      |                             noop|push|pull|create|refuse|shared-defer.
      |                             Depends on the Notion gateway + canonicalizer ONLY;
      |                             no dependency on the merge planner or base reads.
      |                             local/remote terminate in a direct apply; shared defers.
      |
      +--(only when source: shared)--> Shared strategy (leaf)
                                       SOLE importer of the merge planner and SOLE
                                       reader/writer of base_snapshot objects. Wraps
                                       the core with base-load + 3-way merge +
                                       conflict.roughdraft; re-settles a fresh base
                                       after every clean apply. Reached only via
                                       source: shared (R32).
```

Three layers; merge/base code is a compile-time-isolated leaf:

- **Tree orchestration** — target discovery (file|dir), duplicate-`page_id`
  preflight (reject before any mutation), bounded concurrency, per-file result
  aggregation. Direction-agnostic; maps the per-page core over each file.
- **Stateless per-page reconcile core** —
  `render(local) ⇄ read(current remote)` → canonical-normalize both (R33) →
  decide `noop|push|pull|create|refuse|shared-defer`. Depends on the Notion gateway +
  canonicalizer only; has NO dependency on the merge planner or base reads, so
  single-source cannot construct a base (R31/R32 enforced by the dependency
  graph). For `local`/`remote` it terminates in a direct apply; for `shared` it
  defers.
- **Shared strategy (leaf)** — the SOLE importer of the merge planner and SOLE
  reader/writer of `base_snapshot` objects. Wraps the core with base-load +
  3-way merge + `conflict.roughdraft`; re-settles a fresh base after every clean
  apply. Reached only via `source: shared` (R32).

`status` is the safe overview verb and never reaches the apply tail. Write
commands additionally expose `--dry-run`, which runs the same planning and
validation as `sync` or `track` but commits no mutation and records no durable
preview state.

### Bake-off record

Four candidate realizations (CLI shape + internal layering) were designed and
adversarially self-scored against the requirement invariants and the R36
simplicity bar:

| Candidate | Shape                  | Verbs                          | Note                                                        |
| --------- | ---------------------- | ------------------------------ | ----------------------------------------------------------- |
| A         | refined 3-verb         | `track` / `status` / `sync`    | Structural rigor: schema-gated single-source statelessness. |
| B         | 2-verb minimal floor   | `track` / `sync` (`sync -n`)   | Folds preview into `--dry-run` on the mutating verb.        |
| C         | git-native 3-verb      | `track` / `status` / `sync`    | git porcelain framing; direction as per-file `source`.      |
| D         | inference-first 2-verb | `track` / `sync` (`--dry-run`) | Frontmatter-inferred direction; preview as a flag.          |

Consolidated scorecard (lower is simpler except where noted; ✗ fails the gate):

| Metric (R36)               | Bar | A   | B   | C   | D   |
| -------------------------- | --- | --- | --- | --- | --- |
| Verbs                      | ≤ 3 | 3   | 2   | 3   | 2   |
| Common-path flags          | 0   | 0   | 0   | 0   | 0   |
| Total flags                | ≤ 8 | ≤ 7 | ≤ 7 | ≤ 7 | ≤ 7 |
| Common-path concepts       | ≤ 4 | 3   | 3   | 3   | 3   |
| Steps-to-first-success     | ≤ 2 | 2   | 2   | 2   | 2   |
| Adversarial footguns (R30) | 0   | 0   | ✗ 1 | 0   | ✗ 1 |

**Decision.** The 3-verb surface wins. The 2-verb designs (B, D) save exactly
one verb by making `sync --dry-run` carry the whole overview/preview role. That
removes the always-safe status surface and makes the first inspection command a
variant of the mutating verb, which is a newcomer footgun. The winner
synthesizes A's structural rigor (schema-gated single-source statelessness),
C's git-native framing (no push/pull; direction as per-file `source`; porcelain
`status`), and D's inference discipline (dispatch on frontmatter, never flags).
Safe overview lives on `status`, while write commands still expose `--dry-run`
for execution-local planning without mutation.

### Supersession map

The v-next surface supersedes these older model shapes. The map is retained to
show which invariants replace the previous design assumptions.

| Older model shape                                                                                               | Superseded by                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [CLI](#cli) (`--from-remote`, `--root`, `--root-file`, two-arg `sync`, separate `plan`, file-vs-tree branching) | `track` / `status` / `sync` on self-describing files; `plan` folded into `status` (R34)               |
| Old push/pull coordinator with always-on base re-read + merge                                                   | stateless live-reconcile for single-source; base+merge only for `source: shared` (R09, R11, R31, R32) |
| [Merge And Conflict Policy](#merge-and-conflict-policy) (base/3-way as default)                                 | merge apparatus relocated to the `shared` strategy leaf (R32)                                         |
| [Local Format](#local-format) base-snapshot-per-pull / sidecar-always                                           | sidecar/base only for `source: shared`; single-source carries none (R31)                              |
| in-sync as body-hash equality                                                                                   | in-sync as semantic equivalence under a specified canonical relation (R33)                            |
| multi-mode `sync` (direction by flag/arity)                                                                     | single `sync` that dispatches per file on frontmatter `source` (R34)                                  |

### Resolved design decisions

- **DQ-VNEXT-1 (canonical normalization for R33).** Normalize BOTH sides
  (applied to the block-tree-rendered body, not raw lossy endpoint markdown) by
  folding presentation-only differences: emphasis-marker choice (`*`↔`_`,
  `**`↔`__`), ordered-list renumbering (`2.`→`1.` resequencing), loose-vs-tight
  list spacing, table-alignment/padding whitespace, and trailing-whitespace +
  blank-line-run collapse. Do NOT fold semantic/block-type differences (heading
  level, divider presence, paragraph-vs-heading adjacency, code-fence language,
  list ordinal order) — those are the #756/#759/#763 shapes that must stay
  distinct. The relation is equality of the canonical normal form, hence
  reflexive/symmetric/transitive by construction; the proof obligation is
  property tests (`normalize(normalize(x)) == normalize(x)`; equivalence via
  canonical hash) plus golden-corpus agreement. It lives in a pure
  `Canonicalizer` module shared verbatim by `status` and `sync`, so preview and
  apply can never disagree.
- **DQ-VNEXT-2 (is `shared` a distinct on-disk shape?).** No — `shared` is a
  `source` VALUE on the same file shape. Base/merge state attaches only via the
  page-id-keyed sidecar `.notion-md/sync/<page_id>.json`, established lazily on
  first `shared` sync and GC-able when a file leaves `shared`. This keeps
  dispatch uniform and the common single-source file free of merge cruft.
- **DQ-VNEXT-3 (concrete R36 thresholds).** verbs ≤ 3; common-path flags = 0;
  total flags ≤ 8; mental-model concepts on the common path ≤ 4;
  steps-to-first-success ≤ 2; adversarial footgun pass = 0 triggerable. The
  decided design scores 3 verbs / 0 common-path flags / ≤ 8 total flags / 3
  concepts / 2 steps / 0 footguns.

## Scope

This spec defines:

- the `.nmd` local file contract,
- the `.notion-md` content-addressed local state store,
- sync surfaces and guarded conflict policy,
- CLI, batch, and watch behavior,
- Effect service boundaries,
- OpenTelemetry conventions,
- verification expectations and known limitations.

This spec does not define:

- a generic Notion renderer,
- a rich text editor,
- a full offline Notion clone,
- a replacement syntax for Notion enhanced Markdown.

## System Shape

```
notion-md CLI
  |
  |  track/status/sync/watch
  v
Path, batch, and tree orchestrators
  |
  |-- target discovery, tree membership preflight, duplicate page-id preflight, bounded concurrency
  v
Source-dispatched reconcile engine
  |
  |-- Local .nmd file
  |-- .notion-md/objects/sha256/<hash>.json
  |-- Notion Markdown endpoint
  |-- Notion page/property APIs
  |-- Notion block API for unsupported blocks
  |-- Future: comments, files, data-source schema, webhooks
```

Requirement trace: R01-R05, R16-R24.

The system treats Notion enhanced Markdown as one sync surface, not the whole page. The body surface is stock Notion enhanced Markdown. Local metadata, page properties, unsupported block preservation, files, comments, and review state are modeled outside the body so they are never silently sent as Notion Markdown.

The public body facade exposes body-only observe, local read, materialize,
verified remote replace, and clean-base settlement operations for adapters that
compose with `.nmd` files. The facade depends on `NotionMdGateway` and
`NmdStateStore`; it does not expose sync coordinator decisions or page metadata
mutation as an adapter surface.

Remote body observations carry `@overeng/notion-core` body-completeness
evidence produced by `@overeng/notion-effect-client` live observation.
`notion-md` is the package that turns that evidence into clean-base policy:
single-page establishment, tree materialization, clean-base refresh, and the
body facade must refuse to treat a lossy Markdown observation as a clean `.nmd`
base.

Batch and folder support do not change the ownership unit: one `.nmd` file maps
to one Notion page, and every mutation still passes through the same page-local
guards. The batch layer only owns target discovery, duplicate page-id preflight,
bounded concurrency, per-file result reporting, and multi-file watch scheduling.

## Local Format

```
doc.nmd
  frontmatter: strict local sync envelope
  body: stock Notion enhanced Markdown

.notion-md/
  objects/sha256/<2>/<62>.json
  sync/<page-id>.json
```

Requirement trace: R06-R10.

### `.nmd` Envelope

The `.nmd` file is a versioned local wrapper around a Notion enhanced Markdown body.
Version 2 keeps human-editable state in the file and moves derived sync
bookkeeping into a page-id keyed sidecar:

```markdown
---
{
  'notion_md':
    {
      'version': 2,
      'api_version': '2026-03-11',
      'object': 'page',
      'page_id': '00000000-0000-4000-8000-000000000001',
      'parent': { '_tag': 'page', 'id': '00000000-0000-4000-8000-000000000000' },
      'page':
        {
          'title': 'Page title',
          'icon': null,
          'cover': null,
          'in_trash': false,
          'is_locked': false,
        },
      'properties': {},
    },
}
---

Enhanced Markdown body starts here.
```

Rules:

| Rule                | Specification                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- |
| Body boundary       | Only bytes after frontmatter are sent to Notion Markdown endpoints.                    |
| Strict schema       | Unknown frontmatter keys are errors.                                                   |
| Body hash           | Hash canonical stripped body bytes, never frontmatter.                                 |
| API version         | `api_version` records the Notion API version used for the last clean pull.             |
| Local version       | `notion_md.version` is the local human-editable envelope version.                      |
| Sync sidecar        | Derived state lives in `.notion-md/sync/{page_id}.json`, keyed by immutable page id.   |
| Visible frontmatter | A page whose visible body starts with `---` must escape or precede that text.          |
| Review markup       | Roughdraft markers are local review state unless an explicit push mode says otherwise. |

Local experiments confirmed that frontmatter sent through the Markdown endpoint becomes literal body content. Push must strip it.

### Frontmatter Schema

The Effect Schema in `@overeng/notion-effect-client` is the source of truth. The
current local shape is split between human-editable V2 frontmatter and
machine-managed V1 sync state:

```ts
type NmdFrontmatterV2 = {
  readonly notion_md: {
    readonly version: 2
    readonly api_version: '2026-03-11'
    readonly object: 'page'
    readonly page_id: NotionId
    readonly url?: string
    readonly parent: ParentRef
    readonly page: PageState
    readonly properties: Record<string, WritablePropertyValue>
  }
}

type NmdSyncStateV1 = {
  readonly version: 1
  readonly page_id: NotionId
  readonly body: BodyState
  readonly storage: SelfContainedStorage | ObjectStoreStorage
  readonly read_only_properties: Record<string, ReadOnlyPropertyValue>
  readonly data_source: DataSourceBinding | null
}
```

Schemas use tagged unions for polymorphic values, branded strings for Notion IDs and hashes, and exact decoding with excess-property rejection.

### Writable Property Values

Property frontmatter is human-editable only for modeled writable forms. Unknown or generated properties remain visible as read-only values.

| Notion property type | Local form                 | Push encoding                 |
| -------------------- | -------------------------- | ----------------------------- |
| `title`              | string                     | rich-text title from string   |
| `rich_text`          | string or null             | rich text from string         |
| `number`             | number or null             | number                        |
| `select`             | option name or null        | select by name                |
| `multi_select`       | option names               | multi-select by names         |
| `status`             | option name or null        | status by name                |
| `date`               | Notion date object or null | date object                   |
| `people`             | user IDs                   | people IDs                    |
| `checkbox`           | boolean                    | checkbox                      |
| `url`                | string or null             | url                           |
| `email`              | string or null             | email                         |
| `phone_number`       | string or null             | phone number                  |
| `relation`           | page IDs                   | relation IDs                  |
| `files`              | file refs                  | future file-upload resolution |
| `place`              | place object or null       | place object                  |
| `verification`       | verification state object  | verification object           |
| generated properties | read-only wrapper          | not pushed                    |

Property IDs must be preserved when available. Display names are for readability; IDs win on rename or schema drift.

### Writable Page Metadata

The page metadata surface covers page state that is not part of the Markdown
body and is not a data-source property.

| Field       | Local form                              | Push encoding       |
| ----------- | --------------------------------------- | ------------------- |
| `title`     | string                                  | page title property |
| `icon`      | null, emoji, native icon, external file | page `icon`         |
| `cover`     | null, external or Notion-hosted file    | external/null cover |
| `in_trash`  | boolean                                 | page `in_trash`     |
| `is_locked` | boolean                                 | page `is_locked`    |

Strict frontmatter accepts the read shapes Notion can return. The write planner
only emits page metadata patches for shapes Notion's page update API accepts:
page titles, null/external covers, null/emoji/native/external icons,
`in_trash`, and `is_locked`. Notion-hosted file URLs and custom emojis are
preserved as pulled state until their write behavior is verified.

## Object Store

Requirement trace: R07-R10, R16.

Objects are immutable JSON payloads addressed by exact stored bytes:

```
.notion-md/objects/sha256/ab/cdef....json
```

| Role              | Payload                         | Required validation                                     |
| ----------------- | ------------------------------- | ------------------------------------------------------- |
| `base_snapshot`   | last clean body snapshot        | page id, body hash, object hash, schema version         |
| `storage_payload` | overflow storage payload        | page id, inventory equality with frontmatter, hash      |
| `file_payload`    | future file bytes or metadata   | content hash, media type, local path or upload identity |
| `comment_payload` | future comment bridge state     | comment IDs, discussion IDs, anchor metadata            |
| `schema_snapshot` | future data-source schema state | schema hash, property IDs, data-source id               |

Write order is object first, `.nmd` last. A failed `.nmd` write may leave orphan objects; a future `store gc` removes unreachable objects. Object paths in frontmatter are logical POSIX-style paths; the state store normalizes both expected and stored paths through the platform `Path` service before reading.

Storage policy:

| Case                                        | Storage form                             |
| ------------------------------------------- | ---------------------------------------- |
| Small stable unsupported/file/comment units | inline `storage._tag = "self_contained"` |
| Large storage payload                       | `storage._tag = "object_store"`          |
| Volatile signed Notion URLs                 | `object_store`                           |
| File bytes                                  | future content-addressed file payload    |
| Raw unsanitized API snapshots               | object store only                        |

The implementation currently supports self-contained storage and content-addressed `storage_payload` objects. It rejects legacy sidecar-shaped frontmatter instead of migrating it.

## Sync Surfaces

Requirement trace: R01-R05, R11-R15.

| Surface            | Local state                                        | Remote observation                    | Write API                            | Conflict unit      | Current status              |
| ------------------ | -------------------------------------------------- | ------------------------------------- | ------------------------------------ | ------------------ | --------------------------- |
| Body               | `.nmd` body; base object only for `source: shared` | block-tree render + endpoint evidence | create page, replace/update Markdown | canonical Markdown | implemented                 |
| Page metadata      | frontmatter page fields                            | `GET /pages/{id}`                     | `PATCH /pages/{id}`                  | field              | title/lock/trash/icon/cover |
| Properties         | frontmatter property map                           | `GET /pages/{id}`                     | `PATCH /pages/{id}`                  | property           | modeled writable forms      |
| Unsupported blocks | frontmatter/object storage                         | Markdown + block API                  | preserve or explicit delete          | block id           | guard + preserve metadata   |
| Data-source schema | external datasource-sync state                     | datasource-sync package               | datasource-sync package              | schema hash        | owned by datasource sync    |
| Comments           | future comment payload                             | comments API                          | comments API                         | discussion/comment | designed, not implemented   |
| Files              | future file payload                                | block/file APIs                       | file upload APIs                     | content hash       | modeled, not implemented    |
| Review             | Roughdraft local markup                            | local only or comments API            | explicit bridge only                 | review id          | guard implemented           |

Body conflicts are possible only for `source: shared`, where a base object
exists. `source: local` and `source: remote` are single-source mirrors: they
compare rendered local body with the current remote body and move in the
declared direction without a merge base.

## Track Flow

1. Decode the page id or URL and target path.
2. Retrieve Notion page metadata and observe the remote body through the body
   observation service.
3. Reject file establishment if the observation is lossy.
4. Adopt the block-tree-rendered Markdown as the local body; keep endpoint
   Markdown only as diagnostic evidence.
5. Build a strict frontmatter envelope with explicit `source`.
6. For `source: shared`, also write the base object and sidecar sync state.
   `source: local` and `source: remote` remain stateless.
7. Write the `.nmd` file, or return the planned result for `--dry-run`.

Future selected surfaces add data-source schema, comments, and files before the
write commit.

## Status Flow

1. Reject single-file status for files that are members of a managed directory
   tree; the tree root owns composed child anchors and state.
2. Read and strictly decode `.nmd` frontmatter.
3. Validate local state according to `source`: no sidecar for `local`/`remote`,
   required sidecar for `shared`.
4. Retrieve the current remote page and Markdown for bound files.
5. Return source-specific porcelain status: `unbound`, `in-sync`,
   `local-ahead`, `remote-ahead`, or `diverged`.

## Reconcile Flow

1. Reject single-file sync for files that are members of a managed directory
   tree.
2. Read and strictly decode `.nmd` once.
3. Validate local state according to `source`.
4. Dispatch by `source`, not by CLI flags:
   - `source: local`, unbound: create the remote page under the frontmatter
     parent and bind the returned `page_id`.
   - `source: local`, bound: mirror the local body to Notion when it differs.
   - `source: remote`: pull the current remote body when it differs.
   - `source: shared`: compare base, local, and remote bodies and apply the
     shared merge policy.
5. For `--dry-run`, return the planned result without writing the local file,
   sidecar, object store, or Notion.
6. After writes that establish or refresh a clean base, re-observe the remote
   body and require complete body evidence before settling shared state.

The local file is read once for a reconcile decision to avoid local snapshot
drift. Remote body is re-read immediately before guarded Markdown updates where
the selected write path requires race detection.

Clean-base writes are allowed only from complete body observations with
block-tree-rendered Markdown available. Endpoint truncation, unknown block IDs,
unsupported inventory entries, missing rendered evidence, or a rendered
block-tree suffix not present in the endpoint Markdown all block establishment,
tree materialization, facade settlement, and post-write clean-base refresh. A
successful remote write is not considered settled until the refreshed
observation is complete; otherwise the local `.nmd` base remains untrusted and
the caller receives a typed lossy-remote-body error.

Pull adoption is block-aware. Notion's Markdown endpoint may omit blank block
boundaries around heading/paragraph/divider sequences; reparsing that endpoint
Markdown through CommonMark can promote prose paragraphs to Setext/ATX headings.
`notion-md` therefore treats endpoint Markdown as evidence and adopts the
client block-tree renderer output as the clean body.

## Merge And Conflict Policy

Requirement trace: R11-R15.

`source: shared` body merge operates on canonical Markdown:

| Case                          | Result                                    |
| ----------------------------- | ----------------------------------------- |
| local equals remote           | clean                                     |
| local equals base             | accept remote                             |
| remote equals base            | accept local                              |
| non-overlapping ranges        | merge                                     |
| same-range same edit          | accept merged edit                        |
| overlapping different edit    | conflict                                  |
| protected placeholder removal | conflict unless explicit destructive mode |

`update_content` is an optimization for guarded shared writes. It may be used
only when the base hunk is unique in the current remote body and the returned
Markdown equals the expected body. Ambiguous or deletion-heavy edits fall back
to guarded `replace_content`.

Unresolved shared conflicts are written beside the `.nmd` file as Roughdraft
Markdown:

```markdown
# notion-md body conflict

{==Body conflict==}{>>Remote and local body content both changed since the last clean pull.<<}{id="body-conflict"}

## Base body

...

## Local body

...

## Remote body

...
```

Normal push refuses unresolved Roughdraft review markup. Explicit modes may later apply, render, strip, or bridge review annotations.

## Feature Mapping

Requirement trace: R01-R05.

| Notion feature              | Local body representation               | Non-body state                  | Fidelity / policy                     |
| --------------------------- | --------------------------------------- | ------------------------------- | ------------------------------------- |
| Page title/icon/cover       | not body                                | frontmatter page fields         | title preserved; icon/cover modeled   |
| Page lock/trash state       | not body                                | frontmatter page fields         | field-level page API patch            |
| Paragraphs, headings, lists | stock Markdown/enhanced Markdown        | none                            | supported with Notion normalization   |
| To-dos, quotes, dividers    | stock Markdown/enhanced Markdown        | none                            | supported                             |
| Code blocks                 | fenced blocks                           | language normalization          | supported; aliases may normalize      |
| Equations                   | Markdown/enhanced math syntax           | raw rich-text fallback if lossy | block supported; inline conservative  |
| Callouts, toggles, tables   | enhanced Markdown tags                  | color/attribute normalization   | supported with normalization caveats  |
| Columns                     | enhanced column tags                    | none                            | supported by endpoint, needs coverage |
| Images/files/media          | Markdown/enhanced media tags            | future file payloads            | not fully implemented                 |
| Bookmark/embed/link preview | `<unknown ...>` placeholder             | unsupported block unit/object   | preserve or explicit delete           |
| Child page/database         | enhanced reference tags or placeholders | future ownership records        | preserve by default                   |
| Data-source row properties  | not body                                | typed property map              | modeled writable properties           |
| Data-source schema/views    | not body                                | future schema snapshot          | not implemented                       |
| Comments                    | not body                                | future comment bridge           | not implemented                       |
| Suggestions/review          | Roughdraft local layer                  | review state                    | reject unresolved by default          |

Known Notion enhanced Markdown limitations:

- Notion normalizes valid Markdown on pull.
- Page title and properties are not included in Markdown body output.
- Some blocks pull as `<unknown>` with `unknown_block_ids`.
- The Markdown endpoint can return a prefix of the rendered block tree, such as
  content before a divider; that response is lossy and cannot become a clean
  `.nmd` base.
- The Markdown endpoint can omit separators around block boundaries; the clean
  pull body is rendered from the block tree so paragraphs adjacent to headings
  and dividers keep their block type.
- Signed file URLs expire and are not durable identity.
- Comments support inline Markdown-like content but are separate from body Markdown.
- `allow_deleting_content` can delete child pages/databases and unsupported blocks; the default is non-destructive.

Evidence for these limitations lives in [experiments.md](./experiments.md).

## Effect Services

Requirement trace: R16-R20.

```
CLI program
  provides command tree, option schemas, output renderers

Source-dispatched reconcile engine
  depends on NotionGateway and NmdStateStore
  owns track/status/reconcile decisions

NotionGateway
  depends on NotionConfig and HttpClient
  owns typed Notion API calls and response adaptation

NmdStateStore
  depends on FileSystem and Path
  owns .nmd IO, object refs, object validation, atomic local writes

Merge planner
  pure module for body merge and Markdown update planning

Watch service
  owns event queue, debounce, polling, scoped cancellation
```

Implementation rules:

- Decode untrusted payloads with Effect Schema at the boundary.
- Expected failures use tagged errors with page/file/surface context.
- State-store object reads verify hash, role, schema version, page id, and inventory.
- Layers are composed at process boundaries.
- Long-lived watch resources are scoped and interruptible.
- Pure planning logic stays outside Effect services and has focused unit tests.

## CLI

Current commands:

```bash
notion-md track <page-id-or-url> [file-or-dir] [--as local|remote|shared] [--dry-run]
notion-md status <path...> [--recursive] [--concurrency 4] [--json]
notion-md sync page.nmd [--watch] [--poll-interval-ms 30000]
notion-md sync docs --recursive [--concurrency 4] [--dry-run] [--force] [--json]
```

Environment:

| Variable           | Meaning          |
| ------------------ | ---------------- |
| `NOTION_API_TOKEN` | Notion API token |

Output:

- One-shot commands emit compact human output by default and JSON where
  `--json` is supported.
- Watch emits compact NDJSON event lines by default.
- Watch `sync_error` events include structured typed error fields.
- A future stable output contract may graduate to explicit
  `--output human|json|ndjson` once envelope schemas are versioned.

Future CLI contract:

```bash
notion-md diff <file.nmd> [--surface body|properties|comments|files]
notion-md comments pull|push <file.nmd>
notion-md doctor <page-id-or-url|file.nmd>
notion-md store verify|gc|export <file.nmd>
```

Batch commands:

```bash
notion-md status <target...> [--recursive] [--concurrency 4]
notion-md sync <target> [--recursive] [--concurrency 4] [--watch]
```

Rules:

- A single file target emits a single-page JSON result.
- Multiple status targets or flat recursive directory targets emit a batch envelope.
- Directory targets discover existing `.nmd` files. `status` previews those
  files without mutation, and `sync` reconciles each file according to its own
  `source`.
- Recursive discovery includes existing `*.nmd` files and skips `.notion-md`,
  `.git`, and `node_modules`.
- Duplicate `page_id` values in the same batch are rejected before any Notion
  mutation.
- Missing or malformed files are reported as per-file errors when other valid
  targets can still run.
- Local file deletion, local rename, and remote page moves are not destructive
  intent. Remote archive/delete remains explicit future behavior.

## Watch Lifecycle

Requirement trace: R19-R20, R28.

```
initial event ----\
file event --------> sliding queue -> debounce -> sync pass -> JSON event
remote poll ------/
```

Rules:

- One sync pass runs at a time per process.
- File events and poll events are coalesced.
- Each pass emits `sync` or `sync_error`.
- Sync-pass spans observe failures before the watch loop recovers.
- Interruption closes the watcher, stops polling, and cancels queued work.
- File events come from the Effect Platform `FileSystem.watch` stream. Production
  adapters are thin stream producers; coalescing policy stays in the watch loop.
- Multi-file watch resolves the target set at startup, watches the containing
  directories for those files, coalesces by path, and runs batch sync passes with
  bounded concurrency. New files discovered after startup require restarting the
  watcher until a tree manifest/daemon owns dynamic discovery.

The watch core uses a sliding queue and debounce window. Future tests may inject
source streams and `TestClock`, but production code must stay on Effect Platform
watch primitives instead of raw runtime callbacks.

## Long-Term Decisions

Requirement trace: R01-R24.

| Area                        | Decision                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline equations            | Treat inline equations conservatively until raw rich-text evidence proves Notion's Markdown endpoint preserves equation semantics. If not, preserve spans outside the body.      |
| Page/data-source references | Use stock enhanced Markdown where Notion round-trips references. Preserve unsupported references with block API snapshots and object refs.                                       |
| Property merge bases        | Keep compact bases inline; move large or volatile bases into content-addressed objects by policy.                                                                                |
| Comment anchoring           | Bridge Roughdraft comments only when exact selected text is unique in a known block; otherwise fall back to page-level comments.                                                 |
| Store index                 | Derive reachability from `.nmd` frontmatter and object refs. Add a JSON index only when repo-scale GC or multi-page watch needs it.                                              |
| Batch sync                  | Keep the page/file sync engine as the correctness boundary. Batch and folder modes are orchestration only, with duplicate page-id preflight and per-file results.                |
| Body completeness           | Keep pure vocabulary in `@overeng/notion-core`, live observation in `@overeng/notion-effect-client`, and clean-base adoption/write policy in `@overeng/notion-md`.               |
| Pull body authority         | Adopt block-tree-rendered Markdown as the clean `.nmd` body; retain endpoint Markdown as diagnostic evidence for truncation, unknown blocks, and endpoint/block-tree comparison. |
| Webhooks                    | Polling remains the correctness baseline. A local daemon/tunnel may accelerate refresh; hosted relay is a separate product/security decision.                                    |
| CLI output                  | Use explicit output modes with versioned envelopes. Watch mode uses NDJSON events.                                                                                               |
| Watch events                | Use Effect Platform streams plus a deterministic reducer/queue policy. Avoid raw `fs.watch` ownership in package code.                                                           |

## OpenTelemetry

Requirement trace: R21-R24, R29.

Service names:

| Mode         | `service.name`    |
| ------------ | ----------------- |
| CLI one-shot | `notion-md-cli`   |
| Watch mode   | `notion-md-watch` |

Current implementation uses `notion-md-cli` for both modes and distinguishes watch via attributes. Future process/resource configuration should split them.

Span conventions:

| Span                                | Required attributes                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `notion-md.cli.<command>`           | `span.label`, `notion_md.command`                             |
| `notion-md.sync-page`               | `span.label`, `notion_md.sync.result`, `notion_md.page_id`    |
| `notion-md.status-page`             | local/remote changed booleans, unknown-block count            |
| `notion-md.push-page`               | force flag, destructive flag, push decision, markdown command |
| `notion-md.watch.sync-pass`         | watch reason, command, path basename, error tag when failed   |
| `notion-md.gateway.update-markdown` | page id, update type, content-update count, destructive flag  |
| `notion-md.state.read-object`       | object role, hash prefix                                      |
| `notion-md.state.write-object`      | object role, hash prefix                                      |

Attributes must not include tokens, full Markdown bodies, file bytes, or signed URLs.

## Verification

| Layer           | Required coverage                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| Unit            | schemas, canonicalization, merge planner, hash stability, object refs             |
| Fake E2E        | track/status/sync/watch, source dispatch, tree guards, unknown-block guards       |
| State integrity | corrupt hashes, stale objects, path traversal, inventory mismatch, legacy rejects |
| Live Notion E2E | track/status/sync, watch polling, unknown blocks, merge, property edit            |
| CLI             | command parsing, invalid options, missing token, output contracts                 |
| OTEL            | expected spans and safe attributes                                                |

Implemented verification currently includes:

- pure merge planner tests,
- fake-gateway E2E tests,
- live Notion E2E against a configured parent page,
- live E2E ledger updates on the configured parent page,
- a durable automated demo page synced from `packages/@overeng/notion-md/demo/showcase.nmd`,
- a flat recursive batch demo template under `packages/@overeng/notion-md/demo/workspace/`,
- local `check:quick` and `check:all`.

Live E2E uses `NOTION_TEST_PARENT_PAGE_ID` as a scratch parent. Test-created
child pages are archived during teardown. A stable `notion-md e2e run ledger`
child page records the latest live run so the parent page remains visibly tied
to the test suite without retaining every scratch fixture.

The automated demo page is not a test scratch page. It is the durable 1:1
showcase for local `.nmd` and Notion state. Its local file and reachable object
store entries are committed under `packages/@overeng/notion-md/demo/`.

The batch demo is intentionally a template, not another live fixture set.
Checked-in examples use `.nmd.example` so recursive commands only operate after a
user has pulled distinct real Notion pages into `.nmd` files.

Follow-up hardening remains for required live-lane policy, OTEL span assertions,
versioned CLI output schemas, and broader storage/comment coverage. Watch
coverage already includes polling, structured errors, and batch coalescing in
the fake/live E2E suite; additional watch work should target uncovered lifecycle
or timing edges rather than restating the basic watch-core scenarios.
