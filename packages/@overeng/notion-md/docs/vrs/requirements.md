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
- **R12 Unknown preservation:** Push must refuse to drop unsupported blocks, unknown placeholders, child pages, child databases, or synced block identity unless the user chooses an explicit destructive mode.
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
