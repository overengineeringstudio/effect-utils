# Spec: 01-editor

Specifies the `$EDITOR`-based editing surface — the stateless `cat`/`put` body
pipes, the ephemeral-file-engine `edit` session, the title↔H1 boundary, the
guard plumbing, the exit-code model, the umbrella surface, and the write-path
sync-progress indicator. Builds on [../requirements.md](../requirements.md) +
[./requirements.md](./requirements.md); terms in [../glossary.md](../glossary.md);
rationale in [../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the
architecture index.

Traces: R32–R35, R37, R39, R43–R45. The uniform lossy-page refusal (exit 3) these
verbs enforce is owned by [04-fidelity](../04-fidelity/spec.md) (R30/R38); the
base-snapshot guard `edit` reuses is owned by
[03-sync-engine](../03-sync-engine/spec.md) (R09/R11); hosted-media
canonicalization the base hash depends on is owned by
[04-fidelity](../04-fidelity/spec.md) (R36).

## Editor Surfaces (`cat` / `put` / `edit`)

Requirement trace: R01, R03, R04, R11, R15. These commands let a human (or pipe)
edit a Notion page as Markdown with the canonical editor instead of a persistent
local file. They are two different shapes (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)):

- **`cat` / `put` — stateless body pipes.** Gateway-only (body facade
  `observeRemoteBody` / `replaceRemoteBodyVerified`): no `.nmd` file, no
  `.notion-md/` store, nothing written anywhere. Pure stdin/stdout. `cat`
  additionally supports a read-only `--frontmatter` envelope dump.
- **`edit` — ephemeral file-engine session.** Sugar over the file-based `sync`
  engine: pull the page into a `.nmd` + `.notion-md/` under `$TMPDIR`, present the
  body in `$EDITOR`, push through `syncPage`, then delete the temp tree. Not a
  second push engine.

### Scope boundary

The **stateless pipes (`cat`/`put`)** operate only on the body + title (decision
[0008](../.decisions/0008-streaming-scope-boundary.md)). Surfaces they do not
represent are left untouched on the remote; a user who needs them uses `edit` or
the file-based path. **`edit`**, being engine-backed, additionally reaches the
engine's extras on _representable_ pages.

| Surface                                                        | `cat`/`put`                   | `edit`                     | Notes                                                     |
| -------------------------------------------------------------- | ----------------------------- | -------------------------- | --------------------------------------------------------- |
| body, title                                                    | yes                           | yes                        | the pipe projection                                       |
| writable properties / metadata                                 | `cat --frontmatter` read only | yes (`edit --frontmatter`) | stateless property _write_ dropped (decision 0017)        |
| file bytes / object store                                      | no                            | yes (in `$TMPDIR`)         | hosted media canonicalized either way (0007)              |
| comments, data-source schema                                   | no                            | via engine                 | file/engine only                                          |
| base-snapshot three-way merge                                  | no                            | yes                        | `edit` inherits the engine's 3-way Markdown merge         |
| lossy/opaque blocks (`child_database`, `synced_block`, toc, …) | refused                       | refused                    | uniform refusal at the pull (exit 3, decisions 0016/0017) |
| tree / child-page / move / trash                               | no                            | no                         | file-based `sync`/tree only                               |

### Representation modes

| Mode        | Selector        | Shape                                                 | Available on                      |
| ----------- | --------------- | ----------------------------------------------------- | --------------------------------- |
| Default     | (none)          | `# <title>` then a blank line then the body Markdown  | `cat`, `put`, `edit`              |
| Frontmatter | `--frontmatter` | full `.nmd` envelope (strict JSON frontmatter + body) | `cat` (read), `edit` (read/write) |

Default mode presents the title as a leading H1 (decision [0001](../.decisions/0001-title-as-h1-presentation.md)); the title is
transport-routed through the typed page API on write, never as a body block.
`--frontmatter` carries the writable projection (title + writable metadata +
writable properties + body). **Stateless `put --frontmatter` is not provided**
(decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)): a safe property write needs drift detection, which needs a base
snapshot — so structured property editing is `edit --frontmatter` (interactive,
engine-backed) or the file-based `sync` (scripted). `cat --frontmatter` is a
read-only envelope dump and is always safe in a pipe. The writable projection and
the `schema_snapshot` drift check are owned by [06-data-source](../06-data-source/spec.md).

### Title boundary contract (default mode)

| Situation                        | `cat` emits        | `put` behavior                                              |
| -------------------------------- | ------------------ | ----------------------------------------------------------- |
| Page has a title                 | `# <title>` line 1 | line 1 → typed title API; remainder → body                  |
| Untitled page                    | empty `# ` line 1  | empty title round-trips as untitled                         |
| Body has its own leading H1      | title H1 then body | unambiguous: line 1 is the title, the rest is body verbatim |
| Line 1 is **not** a `# ` heading | n/a                | **refuse, fail-loud** — no silent title mutation (T03)      |

The body sent to Notion always has the title H1 stripped (R01). A missing title
line is refused rather than guessed because silently emptying a title is
property-level data loss.

### Guard plumbing

**`cat` / `put` (stateless pipes):**

- `cat` writes the base hash to **stderr** (`base-hash: sha256:…`); **stdout is
  pure Markdown** for clean piping (decision [0002](../.decisions/0002-base-hash-on-stderr.md)).
- The base hash covers the pipe's writable surface (decision [0006](../.decisions/0006-writable-projection-guard.md)): title + body,
  hosted-media URLs canonicalized (decision [0007](../.decisions/0007-canonicalize-hosted-media-urls.md), [04-fidelity](../04-fidelity/spec.md)), with read-only / computed /
  volatile fields excluded so the hash is stable across pulls and `cat`→`put` is
  idempotent.
- **Canonical serialization (the base hash must be reproducible by an independent
  implementation):** the title+body is serialized as the default-mode `# title`
  - body text with `\n` line endings and hosted-media URLs canonicalized
    (decision 0007), then `sha256` with a `sha256:` prefix. The exact byte form is
    load-bearing for the cross-machine optimistic-concurrency token.
- `put` is guarded by default: it re-reads remote, recomputes the title+body
  hash, and refuses with exit `7` (`NotionMdBodyConflictError`) if it differs
  from `--base-hash`.
- `put` with neither `--base-hash` nor `--force` refuses with guidance. `--force`
  is the explicit destructive mode (R15) and reports that it bypassed the guard.

**`edit` (engine session):** carries **no stderr base hash**. Concurrency safety
comes from the engine's **base snapshot** captured at the ephemeral pull and
compared at `syncPage` push (the same guard the file path uses, decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md),
[03-sync-engine](../03-sync-engine/spec.md)) — stronger than the pipe's 2-way
hash, since the engine can auto-merge non-overlapping concurrent edits. In
`--frontmatter` mode the engine also detects data-source **schema drift** from a
`schema_snapshot` captured at pull ([06-data-source](../06-data-source/spec.md);
the earlier stateless in-buffer fingerprint is gone — superseded by decision
[0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)). Writable vs
read-only/computed property split is `propertyWriteClassFromType` /
`PROPERTY_WRITE_CLASSES` (`@overeng/notion-core`), the single source of truth.

### Exit codes and error model

Each expected failure is a tagged error (R18) mapped to a distinct exit code for
scriptability:

| Exit | Tagged error                | When                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | —                           | success                                                                                                                                                                                                                                                                                                                                                              |
| 1    | `NmdGatewayError`           | gateway/API failure (network, 5xx, rate-limit) — remote unreachable, distinct from a bad-input failure                                                                                                                                                                                                                                                               |
| 2    | (CLI framework)             | bad flags/args                                                                                                                                                                                                                                                                                                                                                       |
| 3    | `NmdRemoteBodyLossyError`   | **the defining refusal (uniform across `cat`/`put`/`edit`)** — the page contains a not-losslessly-representable block (`child_database`, `synced_block`, `table_of_contents`, `child_page`, API `unsupported`, …) and cannot be edited as Markdown; the message names the block and points to the Notion UI or the file-based `.nmd` sync path (decisions 0016/0017) |
| 4    | `NmdUnresolvablePageError`  | `<page>` not a valid id/URL, or page not found                                                                                                                                                                                                                                                                                                                       |
| 5    | `NmdInvalidDocumentError`   | default mode missing leading title H1; malformed `--frontmatter` envelope                                                                                                                                                                                                                                                                                            |
| 6    | `NmdSchemaDriftError`       | `edit --frontmatter` (and file `sync`): the data-source schema changed since the pull, detected by the engine's `schema_snapshot` comparison (R14); resolve by re-pulling, not by `--force`                                                                                                                                                                          |
| 7    | `NotionMdBodyConflictError` | guard conflict — remote moved since `--base-hash` (`put`), or the engine's base snapshot diverged and 3-way merge failed (`edit`)                                                                                                                                                                                                                                    |
| 8    | `NmdEditorAbortedError`     | `edit`: `$EDITOR` exited non-zero → no push                                                                                                                                                                                                                                                                                                                          |
| 9    | `NmdPostPushGateError`      | post-push `semanticEquivalent` gate rejected the result (the page may be mutated — re-`cat`)                                                                                                                                                                                                                                                                         |
| 10   | `NmdPartialWriteError`      | `put` only: one of the two writes (body, title) landed and the other failed (decision 0012); page is in a mixed state — re-`cat`                                                                                                                                                                                                                                     |

The error family uses the `Nmd*` prefix; the one exception is the pre-existing
`NotionMdBodyConflictError` (exit 7), which keeps its legacy `NotionMd*` name.
Exit 3 is checked **at the pull** on all three verbs (for `edit`, at the
ephemeral file-engine pull) — none of them presents a body it cannot round-trip.
Exit 6 is **redefined**: it is no longer the deleted stateless in-buffer
fingerprint but the engine's `schema_snapshot`-based schema-drift
refusal for `edit --frontmatter` / `sync` (decision 0017, R14) — kept on its own
axis from the exit-7 value/body conflict so it is not `--force`-able. Exit 11
(opaque-move) is **removed** (no opaque move, decision 0016). Exit 10 applies
only to the stateless `put`; `edit` inherits the engine's settle-and-re-pull.

### Edge behavior

- **Empty body** on `put` is a valid edit (Notion allows an empty body); it is
  applied. `edit` prints a stderr note if the buffer became empty but still
  pushes.
- **`put`/`edit` operate on an existing bound page only.** Page creation stays on
  the file-based / tree path; an unresolvable or nonexistent page is exit 4.
- **`edit` aborts on a non-zero editor exit** (exit 8, nothing pushed).
- **Two writes, body first (decision 0012):** a `put` is body (`replace_content`)
  then title (typed API). If one lands and the other fails it reports which landed
  and exits 10 (which dominates the exit-9 post-push gate); never silent exit 0.
  Recovery is re-`cat`.
- **Title / body H1 sharp edge:** `put` takes line 1 as the title verbatim even
  when line 2 is also `# …`; a page whose first body block is a `heading_1`
  therefore shows two leading `# ` lines in `cat`. This is parser-deterministic
  but visually duplicated; the only protection against an accidental title wipe
  is the missing-title-H1 refusal (exit 5). `replace_content` preserves a body
  that starts with `# Heading` (verified), so the `put` transport does not eat
  it; only Notion's create-from-Markdown absorbs a leading `#` (not used here).
- **Untitled / empty body:** `cat` emits exactly `# ` (hash + single space) on
  line 1 for an untitled page; an untitled, empty-body page is `# \n` only. `put`
  parses the line-1 remainder after `# ` as the title (empty → untitled). The
  exact bytes are load-bearing for the missing-title-H1 check and idempotence.
- **`--frontmatter` mode never treats a body H1 as the title** — the title lives
  in the frontmatter block; a leading `# …` in the body is ordinary content. The
  title-H1 contract is default-mode only.
- **`--force` is concurrency-only** (decision [0009](../.decisions/0009-force-is-concurrency-only.md)): it bypasses the exit-7 guard
  and nothing else. It does not override the exit-3 lossy refusal, which is
  correctness, not concurrency. Per R15 it reports exactly that it bypassed the
  guard.

### `<page>` resolution

`<page>` accepts a raw page id, a dashed id, or a full Notion URL, resolved
through `parseNotionUuid` from `@overeng/notion-core` (the same contract as
`sync <page-id-or-url>`). An unresolvable value fails fast with guidance (R17).

### `edit` session

`edit` is the canonical-editor convenience and an **ephemeral file-engine
session** (decisions [0003](../.decisions/0003-edit-is-a-session-not-live-sync.md), [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)) — sugar over the `sync` engine, not a separate
push path:

1. `mktemp -d` a session dir under `$TMPDIR` (never the cwd) and `pullPage` the
   page into `<dir>/page.nmd` + `<dir>/.notion-md/`. The pull's
   `assertRemoteMarkdownComplete` gate refuses a lossy page here (exit 3),
   exactly like `cat`/`put`.
2. Present the body to `$VISUAL` → `$EDITOR` → `vi` — default mode strips the
   frontmatter and shows `# <title>` + body; `--frontmatter` shows the full
   envelope. Wait for exit.
3. On a non-zero editor exit, abort (exit 8), nothing pushed.
4. On an unchanged buffer, no-op.
5. Otherwise splice the edit back into the envelope (parse line-1 title H1 into
   the frontmatter title in default mode) and `syncPage` the temp `.nmd`. Because
   every accepted page is representable, `edit` uses a full-body `replace_content`
   (decision 0017), closing the targeted-update silent-partial-apply window.
6. On a conflict the engine writes a `.conflict.roughdraft.md`; `edit` **copies
   it out of `$TMPDIR`** to a durable sibling (`<page>.conflict.md`) and prints
   recovery guidance.
7. Always scope-clean the session dir (success / conflict / abort / interrupt).

No editor plugin is shipped; `edit` works with any `$EDITOR` (decision 0003).

### `edit --read-only` (inspection, never sync)

`edit --read-only` (R46) is the read pipe analogue of the editor: pull and present
the page in `$VISUAL`/`$EDITOR` exactly like `edit`, but on exit **never push and
never write anything to the remote** — discard any edits, scope-clean the temp
tree, and print a stderr note that changes were not synced. Steps 1–2 above run;
steps 5–6 (splice + `syncPage` + conflict relocation) do **not**. No base-snapshot
guard is needed (nothing is written), so a non-zero editor exit is just a clean
no-op, not an abort. Because it never writes, the heavy engine push path is not
required — a read-only session may use the lighter `observeRemoteEditorPage` read
(like `cat`) into a temp file rather than a full engine pull.

- `--read-only` composes with `--frontmatter` (inspect the full envelope
  read-only).
- `--read-only --force` is contradictory (`--force` concerns the push) and is
  **rejected** with a bad-usage error, not silently ignored.
- **Default lossy behavior:** read-only still refuses a not-round-trip-safe page
  at the pull (exit 3, R30/R38), same as `edit`. Relaxing this for read-only —
  since it never pushes, viewing a lossy page is harmless — is a deliberate **open
  design question**, not assumed here.

### Umbrella surface

The commands appear as `notion-md cat|put|edit` standalone and `notion md
cat|put|edit` through the umbrella dispatch. `edit` is additionally promoted to
the top-level alias `notion edit <page>` (decision [0004](../.decisions/0004-umbrella-surfacing.md)).

## Sync Progress Indicator (write path)

Requirement trace: R43–R45. Decision [0018](../.decisions/0018-staged-task-list-sync-progress.md). Scope: the **write path only** — `edit`
save, `put`, and the file-based `sync`/`put` write. `cat` is a read pipe and is
**excluded** (its only stderr output stays the `base-hash:` line).

A write-path sync makes several remote round-trips (status pull, pre-push
re-read, the `replace_content` body write, the typed title write, the post-write
re-observe/settle) with no UI in between, so it reads as a hang. The remedy is a
**discrete-stage** progress indicator, not a smooth `%` bar.

### Why staged, not a percentage

There is no per-block progress data to drive a percentage: `replace_content` is
one opaque server-side call, and the block-tree pull discovers children by a
recursive crawl whose total is unknown until it completes. A `%` would have to
invent a denominator — a fake number that erodes trust the moment a stage stalls.
Discrete named stages answer the real question ("is it hung, and on what?")
honestly: the user sees which step is running and that it is still moving.

### Stages and rendering

The indicator is `@overeng/tui-react`'s **`TaskList`** — one checklist row per
sync stage, each row a `{ id, label, status, message? }` with `status` in
`pending` / `active` (spinner) / `success` / `error` / `skipped`, plus an
`X/total · elapsed` summary line:

```
notion-md edit  ·  3/4 · 2.1s
  ✓ observe        remote body pulled
  ✓ write-body     replace_content
  ⠋ write-title    …
  · settle         pending
```

The four near-identical engine pulls must read as **distinct human stages**
(observe / write-body / write-title / settle, …) so the same mechanical
round-trip surfaces as a legible step rather than an indistinguishable repeat.
The stage vocabulary is a CLI-facing presentation contract, distinct from the
OTEL span names (which stay on `notion_md.*`); a stage may map to several spans or
none.

### Mechanism

- A `ProgressReporter` Effect service (`Context.Tag`) with a **no-op default
  Layer**. The engine emits **purpose-tagged stage events** (stage id + label +
  status transition) to it; in every non-interactive context the events fall on
  the floor with zero rendering cost and no behavior change. The engine stays
  render-agnostic.
- The CLI provides a `TaskList`-backed Layer **only on the write path**, rendered
  through the TUI render seam to **stderr**, gated on `process.stderr.isTTY`. So
  `cat`'s stdout stays pure Markdown (R01, decision 0002) and a piped/redirected
  write (`… | put > file`) degrades to a static line or nothing — never animated
  control sequences in a pipe or log (R44).
- The CLI `TaskList` app is constructed **lazily inside the command handler**, via
  a memoized accessor — never at module top level. notion-md has no runtime TUI
  import today; a top-level `createTuiApp(...)` would re-enter the same
  concurrent-module-load TDZ that crashed the umbrella in #787 (`createTuiApp`
  reached while `@overeng/tui-react` was mid-initialization), so the construction
  is deferred to call time (R45).
- `put`'s two non-atomic writes (decision 0012) surface as two rows, so a partial
  write (exit 10) is visibly the title row failing after the body row succeeded.

### Complementary perf lever

The redundant-4-pulls collapse (folding the near-identical engine pulls into
fewer round-trips) is the complementary performance lever, tracked separately in
**#788**. This indicator makes the existing passes legible; it does not change how
many there are. The two compose: fewer pulls means fewer stages, but the staged UI
stays correct either way.
