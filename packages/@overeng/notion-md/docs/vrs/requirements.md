# Notion Markdown Sync Requirements

These requirements serve [vision.md](./vision.md). They define the production
constraints for a Notion <> Markdown sync tool built on Notion enhanced Markdown
and local versioned state. Terms are defined in [glossary.md](./glossary.md);
rationale for the hard-to-reverse choices lives in [.decisions/](./.decisions/)
and is cross-referenced by ID.

The per-subsystem requirements (preserving the GLOBAL R-IDs) live under the
numeric subsystem dirs — see [spec.md](./spec.md) for the architecture index and
the map of which subsystem owns which requirement. The global Assumptions
(`A01…`) and Tradeoffs (`T01…`) below, plus the cross-cutting surface-boundary,
Effect-native, observability, and verification requirements, are inherited
downward by every subsystem.

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
- **T06 Refuse rather than reconcile lossy pages:** The tool refuses a page whose body contains a not-losslessly-representable block (`child_database`, `synced_block`, table of contents, child page, …) instead of editing it — uniformly across the editor verbs and the file-based `sync` (decision [0017](./.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)) — because Notion's platform bars a sound edit of such blocks (no backlink endpoint, `child_database` uncreatable via the block API, non-injective Markdown endpoint). Losing the ability to edit those pages as Markdown is accepted in exchange for a small, correct, plugin-free design; such blocks are edited in the Notion UI. See decisions [0016](./.decisions/0016-refuse-lossy-pages.md), [0017](./.decisions/0017-edit-is-an-ephemeral-file-engine-session.md). (Owned by [04-fidelity](./04-fidelity/requirements.md).)
- **T07 Editor session, not live sync:** `edit` is a discrete pull-edit-push session over an ephemeral `$TMPDIR` `.nmd` + `.notion-md/` tree (decision [0017](./.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)), not character-level live sync and not a zero-file in-memory buffer. `edit` is therefore not strictly stateless (only `cat`/`put` are); statelessness is preserved where it is intrinsic — the pipes — and traded for engine reuse in `edit`. The simpler, plugin-free, one-engine model is accepted in exchange. (Owned by [01-editor](./01-editor/requirements.md).)
- **T08 No stateless property write:** Structured property editing is available through `edit --frontmatter` (interactive) and the file-based `sync` (scripted), but not as a stateless pipe (`put --frontmatter`). A safe property write needs schema-drift detection, which needs a base snapshot; rather than carry a parallel stateless schema-fingerprint subsystem, that one niche (non-interactive property writes with no temp dir) is dropped in favor of `sync`. See decision [0017](./.decisions/0017-edit-is-an-ephemeral-file-engine-session.md). (Owned by [01-editor](./01-editor/requirements.md) / [06-data-source](./06-data-source/requirements.md).)

## Requirements

The data-loss, surface-boundary, durable-state, editor, and fidelity requirements
are distributed across the subsystem dirs, each keeping its GLOBAL ID (see the
[spec.md](./spec.md) index). The cross-cutting surface-boundary, Effect-native,
observability, and verification requirements below stay at root and are inherited
by every subsystem.

### Must Preserve Surface Boundaries (cross-cutting)

- **R01 Body boundary:** The body sent to Notion must be stock Notion enhanced Markdown with all local metadata stripped.
- **R02 Multi-surface model:** Body, page metadata, properties, data-source schema, comments, files, unsupported blocks, and review state must be represented as distinct sync surfaces.
- **R03 Frontmatter boundary:** Local frontmatter must never be interpreted as Notion-native metadata.
- **R05 Comment boundary:** Notion comments must sync through the comments API or local review metadata, not through the body hash.

(R04 Property boundary → [06-data-source](./06-data-source/requirements.md).)

### Must Be Effect-Native (cross-cutting)

- **R16 Typed services:** Notion API access, local state, merge, file cache, comments, watch, telemetry, and progress reporting must be modeled as Effect services with explicit dependencies.
- **R17 Schema validation:** Every untrusted boundary must decode through Effect Schema: CLI options, frontmatter, object-store payloads, Notion responses, and webhook payloads.
- **R18 Typed errors:** Expected failures must use tagged errors with actionable context; unexpected defects must remain defects.
- **R19 Scoped lifecycle:** Long-lived resources such as watchers, pollers, webhooks, caches, and HTTP clients must be scoped and interruptible.

(R20 Bounded concurrency → [02-file-sync](./02-file-sync/requirements.md).)

### Must Be Observable (cross-cutting)

- **R21 Service identity:** CLI, watch/daemon, and webhook receiver processes must use distinct OpenTelemetry service names.
- **R22 Span coverage:** Every command, watch pass, Notion API request, local state transaction, merge decision, file upload, and destructive decision must emit a meaningful span.
- **R23 Queryable attributes:** Spans must include concise `span.label` plus page, file, surface, operation, result, and Notion request identifiers when available.
- **R24 Safe telemetry:** Trace attributes must not include tokens, full document bodies, private file contents, or expiring signed URLs.

### Must Be Verifiable (cross-cutting)

- **R25 Unit coverage:** Pure parsing, canonicalization, hashing, object-store validation, merge, and storage classification behavior must have deterministic unit tests.
- **R26 Integration coverage:** Effect service boundaries must have integration tests with fake Notion and fake local state services.
- **R27 Notion E2E coverage:** Supported Notion body features and destructive-guard behavior must be verified against real temporary Notion pages with cleanup verification.
- **R29 Trace coverage:** E2E or integration tests must assert the presence of required spans and key non-secret attributes.

(R28 Watch coverage → [02-file-sync](./02-file-sync/requirements.md).)

### Distributed to subsystems

Each global ID lands in exactly one subsystem; cross-references resolve to the
owning subsystem.

| Subsystem                                          | Requirements                                |
| -------------------------------------------------- | ------------------------------------------- |
| [01-editor](./01-editor/requirements.md)           | R32, R33, R34, R35, R37, R39, R43, R44, R45 |
| [02-file-sync](./02-file-sync/requirements.md)     | R20, R28                                    |
| [03-sync-engine](./03-sync-engine/requirements.md) | R09, R11, R13, R15                          |
| [04-fidelity](./04-fidelity/requirements.md)       | R12, R30, R31, R36, R38, R40, R41           |
| [05-local-state](./05-local-state/requirements.md) | R06, R07, R08, R10                          |
| [06-data-source](./06-data-source/requirements.md) | R04, R14                                    |

R42 was removed (the stateless in-buffer schema fingerprint, decision 0017
superseding 0013); it is not reintroduced.
