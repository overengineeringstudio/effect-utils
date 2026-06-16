# Requirements: 04-fidelity

**Role.** The body-fidelity layer that decides what can round-trip as Markdown:
the sound round-trip-safety classifier, the uniform lossy-page refusal at the
pull, the guarded server-side replace (no lossy client-side reconstruction), and
hosted-media URL canonicalization. This is the deliberately **shared** layer —
both the editor pipes ([01-editor](../01-editor/requirements.md)) and the file
path ([02-file-sync](../02-file-sync/requirements.md)), and the engine
([03-sync-engine](../03-sync-engine/requirements.md)) that both call, depend on
it. The refusal is a property of the shared core (the classifier gate), enforced
at the pull on **every** surface.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. R30/R38
are enforced on both the editor and file surfaces but placed by **primary owner**
(the classifier) here and cross-referenced from those subsystems.

## Requirements

### Must Prevent Data Loss

- **R12 No silent loss of non-body content:** A not-round-trip-safe **body** block (`child_database`, `synced_block`, `table_of_contents`, `child_page`-in-body, degraded bookmark/embed, API `unsupported`) must be **refused at the pull** (R30/R38) rather than silently dropped on push — superseding the earlier "preserve + explicit-delete override" model, which live testing proved silently corrupts. A child page **as a tree node** (its own `.nmd` file) is preserved by the file-based tree engine ([02-file-sync](../02-file-sync/requirements.md)), distinct from a child-page block in the body. Resolvable captures (files, media) are preserved out of band in the object store ([05-local-state](../05-local-state/requirements.md)).

### Must Not Silently Drop Or Corrupt Content

- **R30 Lossy-page refusal (uniform):** All editor verbs (`cat`, `put`, `edit`) and the file-based `sync` must refuse a page whose body contains a not-losslessly-representable block (`child_database`, `synced_block`, `table_of_contents`, `child_page`, API `unsupported`, …) at the **pull**, with a message that names the block class and points to the Notion UI. The refusal is a property of the shared core (the classifier gate), not a streaming-only behavior; nothing must ever present or push a body it cannot round-trip. See decisions [0016](../.decisions/0016-refuse-lossy-pages.md), [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md).
- **R31 Guarded body-replace push (`cat`/`put`):** The stateless `put` must push the body through a guarded verified replace (`replaceRemoteBodyVerified` → `replace_content`) plus a typed title write — two writes, body first (decision [0012](../.decisions/0012-non-atomic-title-body-write-order.md)) — not block-level reconciliation. `edit` instead reuses the file engine's guarded push (decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md), [03-sync-engine](../03-sync-engine/requirements.md)). Because lossy pages are refused (R30), `replace_content` never runs over a body containing an opaque block.
- **R36 Hosted-media URL canonicalization:** Hosted-media (signed-URL) blocks must be canonicalized — volatile signature/expiry query params stripped, origin and path kept — at every point a body is hashed, diffed, base-tracked, or gated, including the post-push semantic-equivalence gate, so media-bearing bodies are idempotent and pushable. External (stable) URLs are left untouched. The editor pipe's base hash ([01-editor](../01-editor/requirements.md), R34) depends on this canonicalization.
- **R38 Sound fidelity classification:** The body-fidelity classifier must flag every block whose **body-Markdown rendering does not reparse to the same block** (round-trip-safety) — not only `unsupported`-typed ones, but known-but-lossy blocks (`child_database` → `[embedded db]()`, `table_of_contents` → `[TOC]`, `synced_block`, `child_page`-in-body, degraded bookmark/embed, …) — so the refusal gate (R30) fires at the pull, on the **file path as well as the editor**. This is a correctness prerequisite proven by live testing (experiments.md): today these classify `complete`, so editing an _unrelated_ paragraph silently re-creates them as paragraphs on push (file `sync` and `edit` alike) — a current data-loss defect, not a hypothetical.
- **R40 No lossy client-side reconstruction:** A representable-body push must go through Notion's own `replace_content` server-side parse, never the lossy client `markdownToBlocks`/`parseInlineMarkdown` (live-proven to drop code/quote/to-do/image/nesting/inline marks). No client-side Markdown→block converter is in scope.
- **R41 Guarded Markdown push model:** Both paths must push the body through a guarded Markdown surface — the stateless `cat`/`put` a 2-way guarded verified replace, the file-based path (and `edit`, which reuses it) a 3-way Markdown merge from its base snapshot with a guarded `replace_content`. Neither uses a block-reconciliation engine; pages with opaque blocks are refused uniformly (R30).
