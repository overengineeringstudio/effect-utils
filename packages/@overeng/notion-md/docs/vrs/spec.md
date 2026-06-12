# Spec: notion-md — architecture index

This is the top-level architecture index for `@overeng/notion-md`. It builds on
[requirements.md](./requirements.md); terms are in [glossary.md](./glossary.md)
(inherited downward by every subsystem); the hard-to-reverse rationale is in
[.decisions/](./.decisions/), cited by relative path. The per-subsystem `spec.md`
files carry the detailed design; this page holds only Status, Scope, the system
shape + dependency diagram, the subsystem index, and the cross-cutting
OpenTelemetry, Verification, and residual long-term-decision lists. Evidence lives
in [experiments.md](./experiments.md); the spec-vs-implementation gap in
[impl-delta.md](./impl-delta.md).

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

Defines (across the subsystem specs): the `.nmd` local file contract and the
`.notion-md` content-addressed local state store; the `$EDITOR`-based editor
surface and the write-path progress indicator; sync surfaces and guarded conflict
policy; the shared fidelity classifier and uniform lossy-page refusal; CLI, batch,
and watch behavior; the typed property / page-metadata surface and schema-drift
guard; Effect service boundaries; OpenTelemetry conventions; verification
expectations and known limitations.

Does not define:

- a generic Notion renderer,
- a rich text editor,
- a full offline Notion clone,
- a replacement syntax for Notion enhanced Markdown,
- full data-source schema/view sync (see the [Notion datasource sync spec](../../../notion-datasource-sync/docs/vrs/spec.md)).

## System Shape

```
notion-md CLI                          notion edit <page>  (umbrella alias)
  |                                       |
  |  pull/status/push/sync/watch/batch    |  cat/put/edit (editor surface)
  v                                       v
Batch/tree orchestrator  ────────►  Editor surfaces (01-editor)
  | discovery, dup page-id, concurrency     | cat/put: gateway-only body pipes
  v                                         | edit: ephemeral $TMPDIR file-engine session
Sync coordinator (02-file-sync) ◄───────────┘
  |
  v
Sync engine (03-sync-engine): guarded push · 3-way merge · update/replace selection · canonical base · post-push gate · settle · review guard
  |
  +── depends on ──► Fidelity (04-fidelity): classifier · uniform lossy refusal · media canonicalization
  |
  +── reads/writes ─► Local state (05-local-state): .nmd envelope · object store · base snapshots
  |
  +── projects ─────► Data source (06-data-source): writable props/metadata · schema_snapshot drift
  |
  +── Local .nmd file
  +── .notion-md/objects/sha256/<hash>.json
  +── Notion Markdown endpoint · page/property APIs · block API
  +── Future: comments, files, data-source schema, webhooks
```

Requirement trace: R01-R05, R16-R24.

The system treats Notion enhanced Markdown as one sync surface, not the whole page.
The body surface is stock Notion enhanced Markdown. Local metadata, page
properties, unsupported block preservation, files, comments, and review state are
modeled outside the body so they are never silently sent as Notion Markdown.

**Effect service boundaries** (R16-R20). The CLI program provides the command
tree, option schemas, and output renderers. The sync coordinator (depends on
`NotionGateway` + `NmdStateStore`) owns pull/status/push/sync decisions. The
`NotionGateway` (depends on `NotionConfig` + `HttpClient`) owns typed Notion API
calls and response adaptation. The `NmdStateStore` (depends on `FileSystem` +
`Path`) owns `.nmd` IO, object refs, object validation, and atomic local writes.
The merge planner is a pure module. The watch service owns the event queue,
debounce, polling, and scoped cancellation. The `ProgressReporter` service
(`Context.Tag`, no-op default Layer) carries write-path stage events
([01-editor](./01-editor/spec.md#sync-progress-indicator-write-path), R45).
Untrusted payloads decode through Effect Schema at the boundary; expected failures
use tagged errors with page/file/surface context; long-lived watch resources are
scoped and interruptible; pure planning logic stays outside services with focused
unit tests.

The public body facade exposes body-only observe, local read, materialize,
verified remote replace, and clean-base settlement operations for adapters that
compose with `.nmd` files (the `cat`/`put` engine). The facade depends on
`NotionMdGateway` and `NmdStateStore`; it does not expose sync coordinator
decisions or page-metadata mutation as an adapter surface. Remote body
observations carry `@overeng/notion-core` body-completeness evidence produced by
`@overeng/notion-effect-client` live observation; `notion-md` turns that evidence
into clean-base policy and refuses to treat a lossy observation as a clean `.nmd`
base ([04-fidelity](./04-fidelity/spec.md)).

### Sync surfaces map

Requirement trace: R01-R05, R11-R15.

| Surface                                  | Local state                    | Pull API                              | Push API                                                 | Owner                                                      |
| ---------------------------------------- | ------------------------------ | ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Body                                     | `.nmd` body + `base_snapshot`  | block-tree render + endpoint evidence | Markdown update endpoint                                 | [03](./03-sync-engine/spec.md)/[04](./04-fidelity/spec.md) |
| Page metadata                            | frontmatter page fields        | `GET /pages/{id}`                     | `PATCH /pages/{id}`                                      | [06-data-source](./06-data-source/spec.md)                 |
| Properties                               | frontmatter property map       | `GET /pages/{id}`                     | `PATCH /pages/{id}`                                      | [06-data-source](./06-data-source/spec.md)                 |
| Unsupported / not-round-trip-safe blocks | frontmatter/object storage     | Markdown + block API                  | refuse at pull (R38); round-trip-safe captures preserved | [04-fidelity](./04-fidelity/spec.md)                       |
| Data-source schema                       | external datasource-sync state | datasource-sync package               | datasource-sync package                                  | datasource-sync                                            |
| Comments                                 | future comment payload         | comments API                          | comments API                                             | (designed)                                                 |
| Files                                    | future file payload            | block/file APIs                       | file upload APIs                                         | (designed)                                                 |
| Review                                   | Roughdraft local markup        | local only or comments API            | explicit bridge only                                     | [03-sync-engine](./03-sync-engine/spec.md)                 |

## Subsystem index

The `0N` prefix encodes reading + dependency order (`0N` may depend on lower
numbers, not the reverse). The decomposition is **layered**: the two surfaces
(01-editor, 02-file-sync) sit on a shared engine (03-sync-engine) that depends on
the shared fidelity layer (04-fidelity), durable local state (05-local-state), and
the typed property surface (06-data-source). Each subsystem `spec.md` opens with a
link up to [../requirements.md](./requirements.md) + its own `requirements.md`.

| #   | Subsystem                               | Spec covers                                                                                                                                                                                        | Requirements                          | Decisions                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| 01  | [editor](./01-editor/spec.md)           | `cat`/`put`/`edit` surfaces, representation modes, title↔H1 boundary, guard plumbing, exit codes, `edit` session, umbrella, sync-progress indicator                                                | R32, R33, R34, R35, R37, R39, R43–R45 | 0001, 0002, 0003, 0004, 0008, 0009, 0012, 0017, **0018** |
| 02  | [file-sync](./02-file-sync/spec.md)     | pull/status/push flows, CLI + batch/tree orchestration, watch lifecycle                                                                                                                            | R20, R28                              | (traces 0017)                                            |
| 03  | [sync-engine](./03-sync-engine/spec.md) | guarded push, 3-way Markdown merge, `update_content`/`replace_content` selection, canonical base, post-push `semanticEquivalent` gate, settle-and-re-pull, review-safety guard, force escape hatch | R09, R11, R13, R15                    | 0002, 0007, 0009, 0012, 0016, 0017                       |
| 04  | [fidelity](./04-fidelity/spec.md)       | sound round-trip classifier, uniform lossy-page refusal, feature mapping, server-side push strategy, hosted-media canonicalization                                                                 | R12, R30, R31, R36, R38, R40, R41     | 0005, 0007, 0010, 0011, 0014, 0015, 0016                 |
| 05  | [local-state](./05-local-state/spec.md) | `.nmd` envelope, frontmatter schema, `.notion-md/` content-addressed object store, base snapshots                                                                                                  | R06, R07, R08, R10                    | 0006                                                     |
| 06  | [data-source](./06-data-source/spec.md) | writable property values, writable page metadata, `data_source` binding, `schema_snapshot` schema-drift guard                                                                                      | R04, R14                              | 0013                                                     |

The `.decisions/` directory (0001–0018) is the authoritative decision log; the
Decisions column above is the citation map. Decision **0016** (refuse lossy pages)
supersedes the reconciler/converter records (0005, 0010, 0011, 0014, 0015);
decision **0017** (edit = ephemeral file-engine session) supersedes 0013 (the
stateless schema fingerprint) and broadens the refusal to uniform; decision
**0018** adds the staged write-path sync-progress indicator.

**Cross-cutting at root by design.** Observability (the OpenTelemetry conventions),
verification expectations, and the Effect service-boundary overview deliberately
stay at this root index rather than living in a subsystem: the 6-way split is by
sync surface and correctness layer and has no observability/testing subsystem to own
them, and each spans all six. A future `07-observability` subsystem could own the
OTEL + verification surface if it grows enough to warrant its own requirements; that
is a possible follow-up, not done now.

## OpenTelemetry (cross-cutting)

Requirement trace: R21-R24, R29.

Service names:

| Mode         | `service.name`    |
| ------------ | ----------------- |
| CLI one-shot | `notion-md-cli`   |
| Watch mode   | `notion-md-watch` |

Current implementation uses `notion-md-cli` for both modes and distinguishes watch via attributes. Future process/resource configuration should split them.

Span conventions:

| Span                                | Required attributes                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion-md.cli.<command>`           | `span.label`, `notion_md.command`                                                                                                                                                              |
| `notion-md.cat`                     | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`                                                                                                                                     |
| `notion-md.put`                     | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`, `notion_md.put.force`, `notion_md.put.body_written`, `notion_md.put.title_written`                                                 |
| `notion-md.edit`                    | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`, `notion_md.edit.outcome`; wraps the engine's `notion-md.sync-page` / `push-page` / `status-page` spans as children (decision 0017) |
| `notion-md.sync-page`               | `span.label`, `notion_md.sync.result`, `notion_md.page_id`                                                                                                                                     |
| `notion-md.status-page`             | local/remote changed booleans, unknown-block count                                                                                                                                             |
| `notion-md.push-page`               | force flag, destructive flag, push decision, markdown command                                                                                                                                  |
| `notion-md.watch.sync-pass`         | watch reason, command, path basename, error tag when failed                                                                                                                                    |
| `notion-md.gateway.update-markdown` | page id, update type, content-update count, destructive flag                                                                                                                                   |
| `notion-md.state.read-object`       | object role, hash prefix                                                                                                                                                                       |
| `notion-md.state.write-object`      | object role, hash prefix                                                                                                                                                                       |

Attributes must not include tokens, full Markdown bodies, file bytes, or signed
URLs — asserted by a span leak-guard test (R24, Group G). All attribute keys use
the `notion_md.*` namespace (not a `nmd.*` shorthand). The write-path stage
vocabulary ([01-editor](./01-editor/spec.md#sync-progress-indicator-write-path)) is
a CLI-facing presentation contract, distinct from these span names. A
`result`/`changed`/`partial_write` attribute per command is desirable hardening not
yet emitted (impl-delta Group G follow-up).

## Verification (cross-cutting)

| Layer           | Required coverage                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| Unit            | schemas, canonicalization, merge planner, hash stability, object refs             |
| Fake E2E        | pull/status/push/sync/watch, property/body concurrency, unknown-block guards      |
| State integrity | corrupt hashes, stale objects, path traversal, inventory mismatch, legacy rejects |
| Live Notion E2E | pull/status/push, stale overwrite rejection, unknown blocks, merge, property edit |
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
versioned CLI output schemas, broader storage/comment coverage, and the staged
sync-progress indicator (decision 0018). Watch coverage already includes polling,
structured errors, and batch coalescing in the fake/live E2E suite; additional
watch work should target uncovered lifecycle or timing edges rather than restating
the basic watch-core scenarios.

## Residual long-term decisions (cross-cutting)

The editor decisions are recorded as individual records in
[`.decisions/`](./.decisions/) (0001–0018) — that directory is the authoritative
decision log. The residual file-based-engine areas below have no individual record
and are summarized here; they must not silently diverge from the records.

| Area                        | Decision                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline equations            | Treat inline equations conservatively until raw rich-text evidence proves Notion's Markdown endpoint preserves equation semantics. If not, preserve spans outside the body. |
| Page/data-source references | Use stock enhanced Markdown where Notion round-trips references. Preserve unsupported references with block API snapshots and object refs.                                  |
| Property merge bases        | Keep compact bases inline; move large or volatile bases into content-addressed objects by policy.                                                                           |
| Comment anchoring           | Bridge Roughdraft comments only when exact selected text is unique in a known block; otherwise fall back to page-level comments.                                            |
| Store index                 | Derive reachability from `.nmd` frontmatter and object refs. Add a JSON index only when repo-scale GC or multi-page watch needs it.                                         |
| Batch sync                  | Keep the page/file sync engine as the correctness boundary. Batch and folder modes are orchestration only, with duplicate page-id preflight and per-file results.           |
| Body completeness           | Keep pure vocabulary in `@overeng/notion-core`, live observation in `@overeng/notion-effect-client`, and clean-base adoption/write policy in `@overeng/notion-md`.          |
| Pull body authority         | Adopt block-tree-rendered Markdown as the clean `.nmd` body; retain endpoint Markdown as diagnostic evidence for truncation, unknown blocks, and comparison.                |
| Webhooks                    | Polling remains the correctness baseline. A local daemon/tunnel may accelerate refresh; hosted relay is a separate product/security decision.                               |
| CLI output                  | Use explicit output modes with versioned envelopes. Watch mode uses NDJSON events.                                                                                          |
| Watch events                | Use Effect Platform streams plus a deterministic reducer/queue policy. Avoid raw `fs.watch` ownership in package code.                                                      |
