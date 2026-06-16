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
- **R33 Title presentation boundary:** Default mode may present the page title as a leading H1, but the title must transport through the typed page API and never as a body block ([R01](../requirements.md#must-preserve-surface-boundaries-cross-cutting)/[R04](../06-data-source/requirements.md)); a missing title line is refused, not guessed.
- **R34 Editor guard:** The stateless `put` must be guarded by default against a caller-supplied base hash (title + body), refuse on remote drift, and bypass the guard only under an explicit `--force` ([R11](../03-sync-engine/requirements.md)/[R15](../03-sync-engine/requirements.md)). `edit` must be guarded by the file engine's base snapshot captured at the ephemeral pull (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)).
- **R35 Editor neutrality:** `edit` must work with any `$VISUAL`/`$EDITOR` and ship no editor plugin.
- **R37 Pipe scope boundary:** The stateless pipes (`cat`/`put`) must operate only on body + title and leave every other surface untouched on the remote; structured property editing and the engine's extras (object store, three-way merge, `unsupported_blocks` preservation) are reached through `edit` or the file-based path, not the pipes. Stateless property _writes_ (`put --frontmatter`) are not provided (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)).
- **R39 Partial-write honesty (`put`):** The stateless `put` is two non-atomic writes (body, then title). On a partial failure it must report which write landed and fail with a distinct code (partial-write dominating the post-push gate), never silently succeed. `edit` inherits the engine's settle-and-re-pull instead.
- **R46 Read-only edit session:** `edit --read-only` must pull and present the page in `$VISUAL`/`$EDITOR` exactly like `edit`, but **never push or write anything to the remote** — any edits are discarded and the `$TMPDIR` temp tree is cleaned up — and it must say so (a stderr note that changes were not synced). It is the editor analogue of a read pipe (`vim -R` / `git show`): no base-hash/guard machinery is needed (nothing is written), and a non-zero editor exit is a clean no-op. `--read-only` composes with `--frontmatter` (inspect the full envelope read-only); `--read-only --force` is contradictory (force concerns the push) and must be rejected, not silently ignored. By default a read-only session still refuses a not-round-trip-safe page at the pull (R30/R38, same as `edit`); relaxing that for read-only — since it never pushes — is a deliberate open question, not assumed.

### Must Make Write-Path Sync Legible

- **R43 Write-path progress visibility:** A write-path command (`edit` save, `put`, and the file-based `sync`/`put` write) must surface its multi-round-trip sync as a **discrete-stage** progress indicator — a per-stage checklist (e.g. observe → write-body → write-title → settle), each stage with a pending/active/done/failed status and an `X/total · elapsed` summary — so the operation does not read as a hang. It must not present a smooth `%`/data progress bar: there is no per-block progress data (`replace_content` is one opaque call; the block-tree pull discovers children by recursive crawl), so a percentage would be fabricated (decision [0018](../.decisions/0018-staged-task-list-sync-progress.md)). The four near-identical engine pulls must read as **distinct human stages** via purpose-tagged stage events. (`cat` is a read pipe and is excluded.)
- **R44 Pipe-safe, TTY-gated rendering:** The progress indicator must render to **stderr** and only when `process.stderr.isTTY`, so `cat`'s stdout stays pure Markdown ([R01](../requirements.md#must-preserve-surface-boundaries-cross-cutting), decision [0002](../.decisions/0002-base-hash-on-stderr.md)) and a piped/redirected write (`… | put > file`) degrades to a static line or nothing — never animated control sequences in a pipe or log (decision [0018](../.decisions/0018-staged-task-list-sync-progress.md)).
- **R45 Zero-cost and crash-neutral when non-interactive:** Progress instrumentation must be **behavior-neutral and zero-cost when non-interactive** (tests, fake/live E2E, non-TTY runs): no output, and no change to any result, error, or exit code, so a write path is byte-identical with the indicator on or off. It is a cross-cutting Effect service ([R16](../requirements.md#must-be-effect-native-cross-cutting)) so the engine stays render-agnostic. Enabling progress must **not reintroduce the umbrella's startup-crash class** (#787) — the indicator's wiring must not run at module load. Mechanism in [01-editor spec](./spec.md#sync-progress-indicator-write-path), decision [0018](../.decisions/0018-staged-task-list-sync-progress.md).
