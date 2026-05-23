# Notion Markdown Sync Open Questions

This document tracks unresolved questions referenced by [spec.md](./spec.md). Resolved answers move into the spec or into [experiments.md](./experiments.md).

## DQ1 Inline Equation Fidelity

Question: Does escaped inline equation output preserve Notion equation semantics, or does `$...$` become literal text during Markdown pull?

Resolution path:

- Create a focused page with inline equation variants.
- Inspect pulled Markdown and raw block/rich-text API payload.
- Decide whether inline equations are supported, normalized, or lossy.

## DQ2 Page And Database Reference Writes

Question: What is the supported write path for page/database references?

Resolution path:

- Test enhanced Markdown reference syntax with canonical Notion URLs, page IDs, and database/data-source references.
- Compare with block API `link_to_page`, child page, child database, and data-source behaviors.
- Classify each as editable Markdown, block API fallback, or preserve-only.

## DQ3 Last-Clean Property Snapshots

Question: Should last-clean property snapshots stay inline in frontmatter, or should they be content-addressed objects?

Resolution path:

- Measure diff size and conflict readability for representative database rows.
- Test schema drift and property rename workflows.
- Choose the smallest shape that still supports three-way property merges.

## DQ4 Roughdraft To Notion Comment Anchoring

Question: When is a Roughdraft anchor stable enough to project to a Notion page or block comment?

Resolution path:

- Define anchor confidence rules: exact unique text, block id, surrounding context, or page-level only.
- Test comment create/list/update/delete/reply behavior with anchored and moved text.
- Decide default bridge fidelity and failure modes.

## DQ5 Store Index Backend

Question: Should `.notion-md/index` start as JSON or SQLite?

Resolution path:

- Estimate object counts for single-page, docs-folder, and data-source sync use cases.
- Test concurrent watch writes and garbage collection.
- Pick JSON if the index remains small and single-writer; pick SQLite if watch/daemon concurrency needs transactions.

## DQ6 Webhook Deployment Shape

Question: Is webhook support a local daemon, hosted service, or optional integration point?

Resolution path:

- Validate Notion webhook verification and HMAC handling.
- Define local dirty-marker format.
- Keep CLI correctness independent from webhook delivery.

## DQ7 CLI Output Modes

Question: What stable output envelopes should one-shot commands and watch mode expose?

Resolution path:

- Define human, JSON, and NDJSON modes with explicit schema versions.
- Test command success, typed errors, and watch `sync_error` events at the CLI boundary.
- Decide which mode is default for TTY, non-TTY, and `--watch`.

## DQ8 Watch Event Core

Question: How should file events, self-writes, poll events, and webhook marks coalesce deterministically?

Resolution path:

- Extract a watch event core with injectable clock/events.
- Test debounce, queue pressure, self-write suppression, and failure recovery with `TestClock`.
- Keep the production file watcher as a thin adapter around the tested core.
