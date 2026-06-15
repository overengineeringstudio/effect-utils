# Notion Markdown Sync Experiments

This document preserves non-normative evidence for [spec.md](./spec.md). It records tested Notion behavior and design consequences; the spec remains the source of truth.

## Enhanced Markdown Feature Matrix

**Hypothesis:** Notion enhanced Markdown can serve as the page body interchange format for most common authoring features.

**Method:** Created temporary child pages under a shared parent with the official `ntn` CLI, pulled each page as Markdown, compared input to output, and trashed all temporary pages.

**Results:**

- Paragraphs, headings, bulleted lists, numbered lists, nested lists, to-dos, quotes, dividers, empty blocks, block equations, callouts, toggles, toggle headings, columns, tables, table of contents, date mentions, and synced block sources round-tripped well enough for first-class support.
- Notion normalized some output: numbered list counters, code language aliases, table indentation, and some escaping.
- External image/audio/video/file/pdf URLs and captions round-tripped, but media block colors were dropped.
- Inline `$...$` equation input pulled back escaped.
- Markdown page-reference syntax failed on write in the tested fixture.
- A structured `link_to_page` block appended through the block API pulled as `<unknown ... alt="alias"/>`, while the raw block API preserved the typed reference.

**Conclusion:** The body surface can be built on enhanced Markdown, but support levels must be feature-gated by E2E evidence. Page/database references and unsupported blocks require block API fallback and local preservation.

Artifacts: `tmp/notion-md-feature-matrix/`.

## Frontmatter Boundary

**Hypothesis:** Local metadata can safely live in `.nmd` frontmatter if stripped before push.

**Method:** Sent YAML-like frontmatter through the Markdown endpoint, then repeated with frontmatter stripped.

**Results:**

- Frontmatter sent to Notion became literal page body text.
- Stripping frontmatter before `replace_content` produced clean pulled Markdown.

**Conclusion:** Frontmatter is a local wrapper only. It must be validated locally and never sent as body content.

## Conflict Semantics

**Hypothesis:** Notion Markdown update APIs can support guarded sync without default last-writer-wins behavior.

**Method:** Exercised `replace_content`, `update_content`, duplicate matches, stale matches, child-page deletion, comments, and Roughdraft markers against temporary pages.

**Results:**

- `replace_content` overwrote simulated remote edits.
- `update_content` failed for stale single matches and duplicated matches unless `replace_all_matches` was true.
- Multi-update behavior was not uniformly fail-fast; a missing hunk could be skipped while another hunk applied.
- Replacing content that would delete a child page failed unless `allow_deleting_content` was true.
- Notion comments are separate from body Markdown and support inline Markdown, not block Markdown.
- Roughdraft markers sent as body content pulled back as visible escaped text.

**Conclusion:** Default push must be guarded. `update_content` is a verified transport optimization, not the merge engine. Roughdraft review state must stay local unless explicitly bridged.

Artifacts: `tmp/notion-md-conflicts/`.

## Object Store And Files

**Hypothesis:** Unsupported blocks and files can be preserved locally without polluting editable Markdown.

**Method:** Created unsupported blocks and file/image blocks, pulled Markdown, fetched block API payloads, tested single-part file upload, and archived temporary pages.

**Results:**

- Bookmark and embed blocks pulled as `<unknown>` placeholders with `unknown_block_ids`.
- Fetching unknown IDs through the Markdown endpoint still returned unknown placeholders.
- Fetching unknown IDs through the block API returned typed payloads.
- `link_preview` was not accepted by the append-child request shape in the tested path.
- The workspace rejected multipart file upload, but single-part upload worked.
- File/image retrieval returned volatile Notion-hosted URLs and expiry times.

**Conclusion:** Unsupported blocks need block API snapshots. File bytes and durable media identity belong in the content-addressed object store; expiring Notion URLs are cache data only.

Artifacts: `tmp/notion-md-sidecar-files/`.

## Data Sources And Properties

**Hypothesis:** Data-source rows require property sync outside body Markdown.

**Method:** Created a disposable database/data source, created a row with typed title/select/multi-select/checkbox/date/url/number properties plus Markdown body, queried the data source, updated properties, read row Markdown, and archived the test database.

**Results:**

- Row properties lived on the page object and data-source schema.
- `GET /markdown` returned body content only.
- Property writes required matching the parent data-source schema.

**Conclusion:** Body-only sync is not acceptable for database rows. Property state needs typed schemas and schema-drift detection.

## Local Storage Size

**Hypothesis:** Compact state can stay in frontmatter, but raw snapshots and file data need escalation.

**Method:** Compared compact typed storage units against raw page/block snapshots and tiny embedded file bytes.

**Results:**

- Compact typed state stayed readable for small fixtures.
- Raw snapshots quickly became noisy and included volatile/private retrieval data.
- Tiny bytes were only acceptable because the fixture was artificially small.

**Conclusion:** the launch format should use strict frontmatter for compact metadata plus a content-addressed object store for base snapshots and bulky or volatile payloads. A separate per-page state file is not needed until property/comment/file surfaces outgrow frontmatter.

## Streaming Editor Surface (`cat`/`put`/`edit`)

**Hypothesis:** A stateless stdin/stdout body surface over the body facade can drive editor-based two-way editing with a guarded push, idempotent round-trips, and lossless preservation of unknown blocks.

**Method:** Live Notion (API `2026-03-11`), scratch pages under the shared test parent, all trashed at teardown. Exercised `observeRemoteBody` / `replaceRemoteBodyVerified` / `updatePageMetadata` / `updatePageProperties` / `updateMarkdown(update_content)` directly. Scripts under `tmp/notion-vim/` (gitignored).

**Results:**

- **Body round-trip is an immediate fixpoint.** A rich body hashed identically across two full pull→push-unchanged→pull rounds. Notion canonicalizes lists, ordered-list counters, code-fence language, and blank lines at _create_ time, so the canonical form must be adopted as the base (the author's pre-canonical source is not the fixpoint).
- **Title is transported out-of-band.** A leading `# H1` was absorbed as the page title and did not appear in the body; `updatePageMetadata` set the title with the body hash unchanged. Validates decision 0001.
- **Guard works.** A stale base-hash `put` was refused with `NotionMdBodyConflictError` (exit 7); remote preserved.
- **Property writability.** Writable properties round-trip via `updatePageProperties`; writing a computed field (`last_edited_time`) is rejected by Notion and unaffected.
- **`last_edited_time` is not a sub-minute change signal.** It is minute-rounded and only advances on a real edit; two no-op pulls never differ on it. Change detection must use body/property hashes, not the timestamp.
- **Hosted-media signed URLs break naive idempotence.** A Notion-hosted image renders the raw signed S3 URL (`X-Amz-*`), which rotates every pull → raw body hash differs between two no-op pulls; external-URL media is stable. URL-canonicalizing the body (strip signature, keep origin+path) makes the hash stable across pulls. Drives decisions 0006 and 0007.
- **`update_content` preserves untouched blocks — but only that.** A targeted block-level patch edited one paragraph while leaving an untouched lossy `child_database` intact. This is _preservation of untouched blocks only_; a follow-up adversarial review proved `update_content` **cannot move or delete** an opaque block from the rendered surface (its rendered token is absent from Notion's endpoint Markdown), and a multi-update batch silently partial-applies. Soundly editing _around_ opaque blocks would have required block-level reconciliation by id — which is why the streaming editor instead **refuses** pages containing opaque blocks (decision 0016) and pushes a representable body through a single guarded `replace_content`. Exception: `replace_content`/`update_content` on a hosted-media page is rejected by the post-push `semanticEquivalent` gate until media URLs are canonicalized there too (decision 0007).

**Conclusion:** The streaming surface is sound on the existing primitives. The one cross-cutting requirement surfaced by live testing is **hosted-media URL canonicalization** at every hash/diff/gate point (including `semanticEquivalent`); it simultaneously fixes media idempotence and unblocks `update_content` on media pages. Decision 0006's idempotence rationale was corrected by this evidence (the volatile axis is the body URL, not metadata).

Artifacts: `tmp/notion-vim/vrs-e2e-results.md`.

## Ephemeral `edit` over the file engine + the silent-loss bug (live)

**Hypothesis:** `edit` can be implemented as an ephemeral file-engine session
(pull into a `$TMPDIR` `.nmd`, edit, `syncPage`, cleanup), and the
classifier/pull gate refuses lossy pages uniformly so no surface corrupts them.

**Method:** Live Notion (API `2026-03-11`), scratch pages under the provided test
parent, all archived by tracked id at teardown (no parent sweep). Ran the real
`notion-md sync` CLI into a `mktemp -d` dir for each block type, edited an
_unrelated_ paragraph, pushed, and compared block-API ground truth. Report:
`tmp/notion-vim/option2-ephemeral-edit-e2e.md`.

**Results:**

- **Transport is sound.** Two-arg establish-pull into a temp dir creates
  `page.nmd` + `.notion-md/` + sidecar; a body edit pushes cleanly; the
  concurrent-remote-edit guard fires (`NmdConflictError`, conflict roughdraft
  written, remote preserved). `edit` needs nothing new from the engine.
- **The fidelity classifier protects _none_ of the renderable-but-lossy blocks
  today — editing an unrelated paragraph silently destroys the untouched block:**
  - `table_of_contents` → re-created as a `[TOC]` paragraph (total loss),
  - `synced_block` → plain paragraph (text survives, sync identity lost),
  - `bookmark` → link paragraph (URL survives, block degraded),
  - `child_database` → survived **only** because Notion's _server_ refused the
    delete (`This operation would delete 1 child page(s) or database(s)`), not
    because the notion-md guard fired.

  Push returned exit 0 with `unresolvedUnknownBlocks: []` and no placeholder — the
  guard never fired, because these blocks classify `complete` (not API
  `unsupported`). Block-API ground truth confirmed the block id was replaced by a
  new paragraph id.

- **Mechanism = the non-injective endpoint, on _any_ edit.** These blocks render
  to body Markdown (`[TOC]`, `[embedded db]()`, plain text) that Notion's parser
  re-creates as a **paragraph** on push. The loss is not specific to `--force`; it
  fires on a normal targeted edit of an unrelated line.

**Conclusion:** This is a **pre-existing file-`sync` data-loss defect**, not an
editor-only concern, and it confirms refuse-lossy is the right call. It sharpens
the R38 criterion: a block is lossy (→ refuse at the pull) iff **its body-Markdown
rendering does not reparse to the same block type** (round-trip-safety), not
merely "type is API `unsupported`". Until the classifier is extended to that
criterion and the pull gate refuses these pages, neither `edit` nor file `sync`
may ship over them. The earlier offline claim that the engine "refuses lossy at
the pull" holds only for API-`unsupported`/`unknown_block_ids`/truncation today;
the renderable-but-lossy class is exactly the R38 gap.

Artifacts: `tmp/notion-vim/option2-ephemeral-edit-e2e.md`.

## Block-Level Reconciliation Feasibility

**Hypothesis:** the body can be pushed by reconciling a desired block tree against the live remote tree by id, using Notion's block REST API.

**Method:** raw REST against the pinned `2026-03-11` API; scratch pages exercising positional insert, delete/update by id, recreate-move per block type, and granular edits around opaque blocks. Scripts under `tmp/notion-vim/`.

**Results:**

- **All four primitives work** on the shipped API. Positional insert uses `position:{type:'after_block',after_block:{id}}` (the `after` param is rejected on `2026-03-11` — renamed, already wrapped in `blocks.ts`); insert _above_ a `child_database` works. Delete-by-id, update-by-id (id retained), and editing one block between opaque blocks while leaving them untouched all succeed.
- **Recreate-move** round-trips paragraph/callout/toggle/column_list/synced_block (original and reference) losslessly — but requires recursively fetching `/children` (never inline), **stripping read-only `null` fields** before re-append, and paginating (>100 children) / respecting nesting depth. It mints a **new id** (breaking inbound references), and **`child_database` is impossible** (not an append-able type).
- **The binding constraint is markdown→block fidelity, not the API.** The existing `markdownToBlocks`/`parseInlineMarkdown` is lossy (drops code fences, quotes, to-dos, images, nesting, inline `code`/`[link]`/`~~strike~~`), so reconstructing edited content through it silently corrupts. A sound client reconciler would have needed a renderer-symmetric converter to avoid this.

**Conclusion:** per-block-by-id reconciliation is _feasible_ on the shipped API but its soundness hinges on a client renderer-symmetric converter, and recreate-move is impossible for `child_database` and unsafe for inbound-referenced originals (no backlink endpoint). Weighed against that cost and those hard platform limits, the design **refuses** pages containing opaque blocks (decision 0016) rather than build the reconciler/converter/recreate-move edifice; this evidence is the rationale for that refusal. The representable-body push needs none of it — Notion's `replace_content` parses the edited Markdown server-side.

Artifacts: `tmp/notion-vim/reconciler-feasibility.md`.

## Stateless Schema-Drift Fingerprint

**Hypothesis:** a schema fingerprint carried in the `--frontmatter` envelope can detect data-source schema drift statelessly.

**Method:** live database/data-source mutations on `2026-03-11`; compute and compare fingerprints across benign and structural changes. Script under `tmp/notion-vim/`.

**Results:**

- **Stateless recovery holds:** `page.parent` carries `data_source_id`, so `put` recovers the exact data source; the schema lives on `GET /v1/data_sources/{id}` (the 2025-09-03+ split).
- **Hashable subset:** `{name, type, sorted option names}` sorted by name, options only for select/multi-select/status; hash _names_ not ids (rename is id-preserving); exclude ids, colors, descriptions, timestamps, `request_id`. Stable across identical reads and a benign color-only change; all five structural mutations produced distinct fingerprints.
- **Not redundant:** writing an unknown select-option _name_ returns **HTTP 200 and silently auto-creates the option**, corrupting the schema — the fingerprint is the only precise pre-write guard.
- `PROPERTY_WRITE_CLASSES` (`@overeng/notion-core`) matches live writable/computed behavior.

**Conclusion:** decision 0013 is sound and implementable; the fingerprint adds real value over Notion's own (silent) handling.

Artifacts: `tmp/notion-vim/schema-fingerprint-verify.md`.
