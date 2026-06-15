# Notion Markdown Sync Requirements

## Context

These requirements serve [vision.md](./vision.md). They define the production constraints for a Notion <> Markdown sync tool built on Notion enhanced Markdown and local versioned state.

## Assumptions

- **A01 Notion API contract:** Notion enhanced Markdown endpoints are the body-content interchange surface, while properties, comments, files, blocks, data sources, and webhooks remain separate API surfaces.
- **A02 Local authority:** Local sync metadata is authoritative only for sync bookkeeping. Notion remains authoritative for current remote page state.
- **A03 Effect runtime:** The implementation uses Effect services, Effect Schema, Effect CLI, scoped resources, and typed errors.
- **A04 Observable operations:** Sync and watch operations are operational workflows and must be traceable through OpenTelemetry.
- **A05 E2E availability:** Production claims about Notion syntax and behavior require real Notion E2E verification.

## Acceptable Tradeoffs

- **T01 Explicit local wrapper:** `.nmd` files may contain frontmatter that generic Markdown tools do not understand because sync safety requires local metadata.
- **T02 Object-store portability cost:** Large or volatile state may live outside the `.nmd` file when keeping it inline would make the document noisy, unsafe, or hard to review.
- **T03 Conservative push defaults:** The tool may block pushes that are probably safe if it cannot prove they preserve remote and out-of-band state.
- **T04 Eventual watch refresh:** Watch mode may use polling or webhooks as triggers, but push correctness must still come from fresh pre-push reads.
- **T05 Partial feature support:** Features without proven E2E fidelity may be preserved as unsupported blocks instead of being editable as first-class Markdown.
- **T06 Refuse rather than reconcile lossy pages:** The tool refuses a page whose body contains a not-losslessly-representable block (`child_database`, `synced_block`, table of contents, child page, …) instead of editing it — uniformly across the editor verbs and the file-based `sync` (decision 0017) — because Notion's platform bars a sound edit of such blocks (no backlink endpoint, `child_database` uncreatable via the block API, non-injective Markdown endpoint). Losing the ability to edit those pages as Markdown is accepted in exchange for a small, correct, plugin-free design; such blocks are edited in the Notion UI. See decisions 0016, 0017.
- **T07 Editor session, not live sync:** `edit` is a discrete pull-edit-push session over an ephemeral `$TMPDIR` `.nmd` + `.notion-md/` tree (decision 0017), not character-level live sync and not a zero-file in-memory buffer. `edit` is therefore not strictly stateless (only `cat`/`put` are); statelessness is preserved where it is intrinsic — the pipes — and traded for engine reuse in `edit`. The simpler, plugin-free, one-engine model is accepted in exchange.
- **T08 No stateless property write:** Structured property editing is available through `edit --frontmatter` (interactive) and the file-based `sync` (scripted), but not as a stateless pipe (`put --frontmatter`). A safe property write needs schema-drift detection, which needs a base snapshot; rather than carry a parallel stateless schema-fingerprint subsystem, that one niche (non-interactive property writes with no temp dir) is dropped in favor of `sync`. See decision 0017.

## Requirements

### Must Preserve Surface Boundaries

- **R01 Body boundary:** The body sent to Notion must be stock Notion enhanced Markdown with all local metadata stripped.
- **R02 Multi-surface model:** Body, page metadata, properties, data-source schema, comments, files, unsupported blocks, and review state must be represented as distinct sync surfaces.
- **R03 Frontmatter boundary:** Local frontmatter must never be interpreted as Notion-native metadata.
- **R04 Property boundary:** Page and row properties must sync through typed page/data-source APIs, not through body Markdown.
- **R05 Comment boundary:** Notion comments must sync through the comments API or local review metadata, not through the body hash.

### Must Maintain Durable Local State

- **R06 Versioned state:** Local sync state must use explicit schema versions and reject unknown fields unless an extension models them.
- **R07 Content addressing:** Large or immutable artifacts must be stored by content hash rather than by transient Notion retrieval URL.
- **R08 Stable references:** Object-store refs must use relative paths plus content addresses that survive repository moves.
- **R09 Base snapshots:** The local state store must preserve last-clean bases needed for guarded push and three-way merge.
- **R10 Volatile URL exclusion:** Expiring Notion file URLs must not be durable local identifiers.

### Must Prevent Data Loss

- **R11 Guarded push:** Default push must re-read remote state and refuse last-writer-wins overwrites when the stored base is stale.
- **R12 No silent loss of non-body content:** A not-round-trip-safe **body** block (`child_database`, `synced_block`, `table_of_contents`, `child_page`-in-body, degraded bookmark/embed, API `unsupported`) must be **refused at the pull** (R30/R38) rather than silently dropped on push — superseding the earlier "preserve + explicit-delete override" model, which live testing proved silently corrupts. A child page **as a tree node** (its own `.nmd` file) is preserved by the file-based tree engine, distinct from a child-page block in the body. Resolvable captures (files, media) are preserved out of band in the object store.
- **R13 Review safety:** Unresolved local review/suggestion markup must not be sent to Notion body content by default.
- **R14 Schema drift safety:** Property writes must refuse or require explicit acceptance when the data-source schema has changed since the last clean pull.
- **R15 Force clarity:** Destructive modes must be separate from normal push and report exactly which protections they bypass.

### Must Be Effect-Native

- **R16 Typed services:** Notion API access, local state, merge, file cache, comments, watch, and telemetry must be modeled as Effect services with explicit dependencies.
- **R17 Schema validation:** Every untrusted boundary must decode through Effect Schema: CLI options, frontmatter, object-store payloads, Notion responses, and webhook payloads.
- **R18 Typed errors:** Expected failures must use tagged errors with actionable context; unexpected defects must remain defects.
- **R19 Scoped lifecycle:** Long-lived resources such as watchers, pollers, webhooks, caches, and HTTP clients must be scoped and interruptible.
- **R20 Bounded concurrency:** Watch mode must serialize or intentionally coordinate sync passes so local writes, remote writes, and state-store updates cannot overlap unsafely.

### Must Be Observable

- **R21 Service identity:** CLI, watch/daemon, and webhook receiver processes must use distinct OpenTelemetry service names.
- **R22 Span coverage:** Every command, watch pass, Notion API request, local state transaction, merge decision, file upload, and destructive decision must emit a meaningful span.
- **R23 Queryable attributes:** Spans must include concise `span.label` plus page, file, surface, operation, result, and Notion request identifiers when available.
- **R24 Safe telemetry:** Trace attributes must not include tokens, full document bodies, private file contents, or expiring signed URLs.

### Must Be Verifiable

- **R25 Unit coverage:** Pure parsing, canonicalization, hashing, object-store validation, merge, and storage classification behavior must have deterministic unit tests.
- **R26 Integration coverage:** Effect service boundaries must have integration tests with fake Notion and fake local state services.
- **R27 Notion E2E coverage:** Supported Notion body features and destructive-guard behavior must be verified against real temporary Notion pages with cleanup verification.
- **R28 Watch coverage:** Watch mode must be tested for debounce, coalescing, cancellation, overlapping events, remote polling, and shutdown.
- **R29 Trace coverage:** E2E or integration tests must assert the presence of required spans and key non-secret attributes.

### Must Not Silently Drop Or Corrupt Content

- **R30 Lossy-page refusal (uniform):** All editor verbs (`cat`, `put`, `edit`) and the file-based `sync` must refuse a page whose body contains a not-losslessly-representable block (`child_database`, `synced_block`, `table_of_contents`, `child_page`, API `unsupported`, …) at the **pull**, with a message that names the block class and points to the Notion UI. The refusal is a property of the shared core (the classifier gate), not a streaming-only behavior; nothing must ever present or push a body it cannot round-trip. See decisions 0016, 0017.
- **R31 Guarded body-replace push (`cat`/`put`):** The stateless `put` must push the body through a guarded verified replace (`replaceRemoteBodyVerified` → `replace_content`) plus a typed title write — two writes, body first (decision 0012) — not block-level reconciliation. `edit` instead reuses the file engine's guarded push (decision 0017). Because lossy pages are refused (R30), `replace_content` never runs over a body containing an opaque block.
- **R38 Sound fidelity classification:** The body-fidelity classifier must flag every block whose **body-Markdown rendering does not reparse to the same block** (round-trip-safety) — not only `unsupported`-typed ones, but known-but-lossy blocks (`child_database` → `[embedded db]()`, `table_of_contents` → `[TOC]`, `synced_block`, `child_page`-in-body, degraded bookmark/embed, …) — so the refusal gate (R30) fires at the pull, on the **file path as well as the editor**. This is a correctness prerequisite proven by live testing (experiments.md): today these classify `complete`, so editing an _unrelated_ paragraph silently re-creates them as paragraphs on push (file `sync` and `edit` alike) — a current data-loss defect, not a hypothetical.
- **R39 Partial-write honesty (`put`):** The stateless `put` is two non-atomic writes (body, then title). On a partial failure it must report which write landed and fail with a distinct code (partial-write dominating the post-push gate), never silently succeed. `edit` inherits the engine's settle-and-re-pull instead.
- **R40 No lossy client-side reconstruction:** A representable-body push must go through Notion's own `replace_content` server-side parse, never the lossy client `markdownToBlocks`/`parseInlineMarkdown` (live-proven to drop code/quote/to-do/image/nesting/inline marks). No client-side Markdown→block converter is in scope.
- **R41 Guarded Markdown push model:** Both paths must push the body through a guarded Markdown surface — the stateless `cat`/`put` a 2-way guarded verified replace, the file-based path (and `edit`, which reuses it) a 3-way Markdown merge from its base snapshot with a guarded `replace_content`. Neither uses a block-reconciliation engine; pages with opaque blocks are refused uniformly (R30).
- **R36 Hosted-media URL canonicalization:** Hosted-media (signed-URL) blocks must be canonicalized — volatile signature/expiry query params stripped, origin and path kept — at every point a body is hashed, diffed, base-tracked, or gated, including the post-push semantic-equivalence gate, so media-bearing bodies are idempotent and pushable. External (stable) URLs are left untouched.

### Must Support Editor-Based Editing

- **R32 Editor surfaces:** The tool must provide stateless stdin/stdout body pipes (`cat`/`put`) that write nothing anywhere, and a canonical-editor convenience (`edit`) that is an ephemeral file-engine session — it may materialize a `.nmd` + `.notion-md/` under `$TMPDIR` but must write nothing to the working directory and clean the temp tree up (decision 0017).
- **R33 Title presentation boundary:** Default mode may present the page title as a leading H1, but the title must transport through the typed page API and never as a body block (R01/R04); a missing title line is refused, not guessed.
- **R34 Editor guard:** The stateless `put` must be guarded by default against a caller-supplied base hash (title + body), refuse on remote drift, and bypass the guard only under an explicit `--force` (R11/R15). `edit` must be guarded by the file engine's base snapshot captured at the ephemeral pull (decision 0017).
- **R35 Editor neutrality:** `edit` must work with any `$VISUAL`/`$EDITOR` and ship no editor plugin.
- **R37 Pipe scope boundary:** The stateless pipes (`cat`/`put`) must operate only on body + title and leave every other surface untouched on the remote; structured property editing and the engine's extras (object store, three-way merge, `unsupported_blocks` preservation) are reached through `edit` or the file-based path, not the pipes. Stateless property _writes_ (`put --frontmatter`) are not provided (decision 0017).
