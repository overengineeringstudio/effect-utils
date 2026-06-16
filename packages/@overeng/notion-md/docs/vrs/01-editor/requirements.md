# Requirements: 01-editor

**Role.** The `$EDITOR`-based editing surface: the stateless stdin/stdout body
pipes (`cat` / `put`) that write nothing anywhere, the canonical-editor
convenience (`edit`) that is an ephemeral file-engine session, the title↔H1
presentation boundary, the per-command guard plumbing and exit-code model, and
the write-path sync-progress indicator. The pipes project body + title only; the
engine's extras are reached through `edit` or the file path, not the pipes.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
uniform lossy-page refusal these verbs enforce is **owned by**
[04-fidelity](../04-fidelity/requirements.md) (R30/R38) — it is a property of the
shared classifier gate, not a streaming-only behavior; this subsystem cites it.
The base-snapshot guard `edit` reuses is owned by
[03-sync-engine](../03-sync-engine/requirements.md) (R09/R11). Hosted-media URL
canonicalization (R36) is owned by [04-fidelity](../04-fidelity/requirements.md);
the pipe base hash depends on it.

## Requirements

### Must Support Editor-Based Editing

- **R32 Editor surfaces:** The tool must provide stateless stdin/stdout body pipes (`cat`/`put`) that write nothing anywhere, and a canonical-editor convenience (`edit`) that is an ephemeral file-engine session — it may materialize a `.nmd` + `.notion-md/` under `$TMPDIR` but must write nothing to the working directory and clean the temp tree up (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)).
- **R33 Title presentation boundary:** Default mode may present the page title as a leading H1, but the title must transport through the typed page API and never as a body block ([R01](../requirements.md#must-preserve-surface-boundaries)/[R04](../06-data-source/requirements.md)); a missing title line is refused, not guessed.
- **R34 Editor guard:** The stateless `put` must be guarded by default against a caller-supplied base hash (title + body), refuse on remote drift, and bypass the guard only under an explicit `--force` ([R11](../03-sync-engine/requirements.md)/[R15](../03-sync-engine/requirements.md)). `edit` must be guarded by the file engine's base snapshot captured at the ephemeral pull (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)).
- **R35 Editor neutrality:** `edit` must work with any `$VISUAL`/`$EDITOR` and ship no editor plugin.
- **R37 Pipe scope boundary:** The stateless pipes (`cat`/`put`) must operate only on body + title and leave every other surface untouched on the remote; structured property editing and the engine's extras (object store, three-way merge, `unsupported_blocks` preservation) are reached through `edit` or the file-based path, not the pipes. Stateless property _writes_ (`put --frontmatter`) are not provided (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)).
- **R39 Partial-write honesty (`put`):** The stateless `put` is two non-atomic writes (body, then title). On a partial failure it must report which write landed and fail with a distinct code (partial-write dominating the post-push gate), never silently succeed. `edit` inherits the engine's settle-and-re-pull instead.

### Must Make Write-Path Sync Legible

- **R43 Write-path progress visibility:** A write-path command (`edit` save, `put`, and the file-based `sync`/`put` write) must surface its multi-round-trip sync as a **discrete-stage** progress indicator — a per-stage checklist (e.g. observe → write-body → write-title → settle), each stage with a pending/active/done/failed status and an `X/total · elapsed` summary — so the operation does not read as a hang. It must not present a smooth `%`/data progress bar: there is no per-block progress data (`replace_content` is one opaque call; the block-tree pull discovers children by recursive crawl), so a percentage would be fabricated (decision [0018](../.decisions/0018-staged-task-list-sync-progress.md)). The four near-identical engine pulls must read as **distinct human stages** via purpose-tagged stage events. (`cat` is a read pipe and is excluded.)
- **R44 Pipe-safe, TTY-gated rendering:** The progress indicator must render to **stderr** and only when `process.stderr.isTTY`, so `cat`'s stdout stays pure Markdown ([R01](../requirements.md#must-preserve-surface-boundaries), decision [0002](../.decisions/0002-base-hash-on-stderr.md)) and a piped/redirected write (`… | put > file`) degrades to a static line or nothing — never animated control sequences in a pipe or log (decision [0018](../.decisions/0018-staged-task-list-sync-progress.md)).
- **R45 No-op when non-interactive; lazy TUI construction:** Progress must be modeled as a `ProgressReporter` Effect service ([R16](../requirements.md#must-be-effect-native)) with a **no-op default Layer**, so the engine emits stage events with zero rendering cost and no behavior change in tests, fake/live E2E, and non-TTY runs; the CLI provides the `TaskList`-backed Layer only on the write path. The TUI app must be constructed **lazily inside the command handler** (notion-md has no runtime TUI import today; a top-level `createTuiApp` would re-enter the concurrent-module-load TDZ that crashed the umbrella in #787) — decision [0018](../.decisions/0018-staged-task-list-sync-progress.md).
