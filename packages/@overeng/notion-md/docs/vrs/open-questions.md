# Notion Markdown Sync Open Questions

This document tracks unresolved questions referenced by [spec.md](./spec.md).
Resolved answers move into the spec or into [experiments.md](./experiments.md).

Resolved and pruned:

- Demo `.notion-md` policy: commit the `.nmd` file plus reachable
  content-addressed objects. Do not commit stale unreachable objects.
- Sidecar split: no redundant sidecar files for page state. The local source of
  truth is strict `.nmd` frontmatter plus content-addressed object refs.
- Page metadata: `icon`, `cover`, `in_trash`, and `is_locked` are modeled in
  strict frontmatter and patched through the page API for proven writable
  shapes.

## DQ1 Inline Equation Fidelity

Question: Does escaped inline equation output preserve Notion equation semantics,
or does `$...$` become literal text during Markdown pull?

Options:

| Option | Approach                                                                                                | Tradeoff                                             |
| ------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A      | Treat inline equations as unsupported until raw rich-text evidence proves round-trip semantics.         | Safest; users see conservative limits.               |
| B      | Accept Notion's escaped Markdown as canonical and document normalization.                               | Simple; risks silently degrading equation semantics. |
| C      | Preserve inline-equation rich-text spans in frontmatter/object storage and render placeholders in body. | Highest fidelity; adds a non-body editing surface.   |

Preferred long-term option: A until proven otherwise, then B only if raw API
evidence confirms the escaped Markdown still maps to a Notion equation object.
Use C if Notion's Markdown endpoint loses equation semantics.

Resolution path:

- Create a focused page with inline equation variants.
- Inspect pulled Markdown and raw rich-text API payload.
- Decide whether inline equations are supported, normalized, or preserved
  outside the body.

## DQ2 Page And Database Reference Writes

Question: What is the supported write path for page/database references?

Options:

| Option | Approach                                                                                  | Tradeoff                                    |
| ------ | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| A      | Only preserve references pulled from Notion; do not author them from Markdown.            | Safe but not complete.                      |
| B      | Use enhanced Markdown for references that round-trip and block API fallback for the rest. | Best ergonomics; requires a feature matrix. |
| C      | Treat all references as explicit frontmatter/object units with body placeholders.         | Strong identity; less Markdown-native.      |

Preferred long-term option: B. Use stock enhanced Markdown where Notion proves a
stable write/read contract, and preserve unsupported reference types with block
API snapshots and object refs.

Resolution path:

- Test enhanced Markdown reference syntax with canonical Notion URLs, page IDs,
  and database/data-source references.
- Compare with block API `link_to_page`, child page, child database, and
  data-source behavior.
- Classify each as editable Markdown, block API fallback, or preserve-only.

## DQ3 Property Merge Bases

Question: How should last-clean property state be represented once property
merging grows beyond simple writable patches?

Options:

| Option | Approach                                                                   | Tradeoff                                                        |
| ------ | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A      | Keep compact last-clean property bases inline in frontmatter.              | Self-contained and reviewable; can become noisy for large rows. |
| B      | Store every property base as a content-addressed object.                   | Uniform and scalable; more files for simple pages.              |
| C      | Hybrid: inline compact bases, object-store large/volatile bases by policy. | Matches current storage model; needs clear thresholds.          |

Preferred long-term option: C. Keep simple row state self-contained, but use the
same content-addressed object policy already used for body bases and bulky
storage payloads.

Resolution path:

- Measure diff size and conflict readability for representative data-source
  rows.
- Test schema drift and property rename workflows.
- Choose thresholds and merge units for three-way property merges.

## DQ4 Roughdraft To Notion Comment Anchoring

Question: When is a Roughdraft anchor stable enough to project to a Notion page
or block comment?

Options:

| Option | Approach                                                                                    | Tradeoff                                             |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A      | Page-level comments only.                                                                   | Very reliable; weak locality.                        |
| B      | Anchor only when exact selected text is unique in a known block.                            | Good safety/utility balance; misses ambiguous cases. |
| C      | Maintain rich anchor objects with block id, text range, context, and fallback page comment. | Best fidelity; highest schema and lifecycle cost.    |

Preferred long-term option: B first, designed so C can extend the schema without
changing the local review model.

Resolution path:

- Define anchor confidence rules: exact unique text, block id, surrounding
  context, or page-level only.
- Test comment create/list/update/delete/reply behavior with anchored and moved
  text.
- Decide default bridge fidelity and failure modes.

## DQ5 Store Index And Garbage Collection

Question: Does `.notion-md` need a persistent index, and if so should it be JSON
or SQLite?

Options:

| Option | Approach                                                         | Tradeoff                                                                           |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A      | No index; derive reachability from `.nmd` files and object refs. | Simplest and correct for single-page/package fixtures; slower GC over large trees. |
| B      | JSON index per workspace.                                        | Inspectable and easy to diff; weak concurrent-write semantics.                     |
| C      | SQLite index.                                                    | Transactional and scalable; heavier dependency and migration surface.              |

Preferred long-term option: A until repository-scale garbage collection or a
multi-page watch daemon needs an index. If needed, use B for single-writer CLI
state and only move to C for concurrent daemon/webhook writes.

Resolution path:

- Estimate object counts for single-page, docs-folder, and data-source sync use
  cases.
- Test concurrent watch writes and garbage collection.
- Pick the smallest backend that preserves atomicity.

## DQ6 Webhook Deployment Shape

Question: Is webhook support a local daemon, hosted service, or optional
integration point?

Options:

| Option | Approach                                                                | Tradeoff                                                         |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A      | No webhook dependency; polling remains the default.                     | Reliable local CLI; slower remote-change detection.              |
| B      | Local daemon receives webhooks through a user-provided tunnel or relay. | Fast local updates; operational setup burden.                    |
| C      | Hosted relay writes dirty markers for local clients.                    | Best UX; introduces hosted infrastructure and security boundary. |

Preferred long-term option: A as the correctness baseline, B as the first
optional acceleration path. C needs a separate product/security decision.

Resolution path:

- Validate Notion webhook verification and HMAC handling.
- Define local dirty-marker format.
- Keep CLI correctness independent from webhook delivery.

## DQ7 CLI Output Modes

Question: What stable output envelopes should one-shot commands and watch mode
expose?

Options:

| Option | Approach                                                  | Tradeoff                                                       |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------- |
| A      | JSON-only for all commands.                               | Easy for agents; poor human terminal UX.                       |
| B      | Human output for TTY, JSON for non-TTY, NDJSON for watch. | Familiar CLI behavior; requires explicit `--json` for scripts. |
| C      | Explicit `--output` modes for human, JSON, and NDJSON.    | Stable and predictable; slightly more verbose.                 |

Preferred long-term option: C with `auto` as a convenience alias once schemas are
stable. Watch mode should use versioned NDJSON event envelopes.

Resolution path:

- Define human, JSON, and NDJSON modes with explicit schema versions.
- Test command success, typed errors, and watch `sync_error` events at the CLI
  boundary.
- Decide which aliases are allowed for TTY and non-TTY use.

## DQ8 Watch Event Core

Question: How should file events, self-writes, poll events, and webhook marks
coalesce deterministically?

Options:

| Option | Approach                                                              | Tradeoff                                         |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------ |
| A      | Keep the current direct `fs.watch` loop.                              | Small; hard to test causality.                   |
| B      | Extract a pure event reducer with injectable clock and source events. | Testable and Effect-native; some upfront design. |
| C      | External queue/index service for watch and webhook events.            | Scales to daemons; premature for the CLI.        |

Preferred long-term option: B. Keep production `fs.watch` and polling as thin
adapters around a deterministic Effect stream/reducer core.

Resolution path:

- Extract a watch event core with injectable clock/events.
- Test debounce, queue pressure, self-write suppression, and failure recovery
  with `TestClock`.
- Keep the production file watcher as a thin adapter around the tested core.
