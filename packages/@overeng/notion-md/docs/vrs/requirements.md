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
- **R09 Shared-only base snapshots:** Stored base snapshots exist only for pages declaring `source: shared` (see R31). For those pages the local state store must preserve the last-clean base needed for guarded push and three-way merge. Single-source pages (`source: local` / `source: remote`) carry no stored base, so no base can drift stale.
- **R10 Volatile URL exclusion:** Expiring Notion file URLs must not be durable local identifiers.

### Must Prevent Data Loss

- **R11 Mode-scoped overwrite guard:** Push must re-read current remote state and refuse to clobber unseen remote edits. For single-source pages this is a stateless live comparison against the freshly read remote (no stored base, no last-writer-wins): a push proceeds only when the rendered local body is semantically equivalent (R33) to the current remote or the page is unbound. For `source: shared` pages the guard is the base-anchored three-way merge of R09; it refuses last-writer-wins overwrites when the remote has diverged from the stored base, and `--force` is the only override.
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
- **R26 Integration coverage:** Effect service boundaries must have integration tests with fake Notion and fake local state services. Fake gateways are sufficient for service-wiring and control-flow coverage but are insufficient for fidelity claims (R35): a hand-written fake re-bakes the same blind spots that let real round-trip bugs through, so fidelity must be proven against a corpus captured from real Notion (R27, R35).
- **R27 Real-Notion fidelity and live coverage:** Round-trip fidelity must be verified against a golden corpus of real Notion page shapes (R35) — captured from live Notion, then replayed offline so it gates every change without requiring network access. A thinner required live-smoke tier must additionally exercise supported body features and destructive-guard behavior against real temporary Notion pages with cleanup verification, so live API drift surfaces deliberately.
- **R28 Watch coverage:** Watch mode must be tested for debounce, coalescing, cancellation, overlapping events, remote polling, and shutdown.
- **R29 Trace coverage:** E2E or integration tests must assert the presence of required spans and key non-secret attributes.
- **R30 Adversarial footgun coverage:** The historically observed footgun classes must each have an adversarial test that attempts to trigger the footgun and asserts it is now structurally impossible: stale-stored-base poisoned-noop (no stored base exists for single-source pages, so the failure mode is unreachable), cosmetic perpetual churn (a semantically-equivalent hand-authored page must reach `noop`, R33), and the divider/paragraph/heading fidelity corruption classes (R35).

### Must Be Frictionless And Progressively Disclosed

These invariants make the common single-source path pay zero stored-state complexity, while reserving the base-snapshot + merge apparatus exclusively for pages that opt into bidirectional behavior.

- **R31 Single-source statelessness:** A page authored on exactly one side — local→Notion (`source: local`, "push") or Notion→local (`source: remote`, "pull") — must carry no base snapshot and no `.notion-md/` sidecar entry. Its in-sync decision must be a live comparison between the freshly rendered local body and the freshly read current remote body, so there is no stored base that can drift stale. The poisoned-noop failure class (a stale stored base reporting in-sync while the page is actually stale, recoverable only by deleting `.notion-md/`) must therefore be structurally unreachable for single-source pages.
- **R32 Progressive disclosure of stored state:** Stored state — base snapshots, three-way merge, and `conflict.roughdraft` artifacts — must be engaged only for pages declaring `source: shared`, and only to buy genuinely bidirectional reconciliation. Stored state must never be required merely to emit a warning or to decide a single-source push/pull. `source: shared` is the one boundary where this apparatus is allowed to appear.
- **R33 In-sync is semantic equivalence:** "In sync" must mean semantic equivalence under a specified canonical normalization applied identically to both sides — not byte-equality. Cosmetically-different-but-semantically-equal bodies (e.g. `*`↔`_` emphasis, ordered-list renumbering `2.`→`1.`, loose-vs-tight lists, table-alignment whitespace) must count as in-sync and reach `noop`, so hand-authored pages are not mangled and `sync` fires only on a real semantic change. The equivalence relation must be specified (reflexive, symmetric, transitive over the normalization) and property-tested (R34, R25). This subsumes the perpetual-churn class (#756).
- **R34 Self-describing files / frontmatter dispatch:** Each file must carry its own identity (`page_id`), `parent`, and direction (`source: local | remote | shared`, default `local`) in frontmatter. The engine must dispatch on frontmatter, not on CLI flags or invocation arity — so the steady-state surface needs no `--from-remote`, `--root`, `--root-file`, two-arg `sync`, or file-vs-tree branching to express direction. An unbound local file (no `page_id`) is the create-on-push case.
- **R35 Fidelity corpus guarantee:** Round-trip fidelity must be guaranteed by a corpus of real Notion page shapes that round-trip semantically (R33), covering at minimum the historically-broken shapes: paragraph-after-list (#756), paragraph↔heading adjacency (#763), and divider boundaries (#759). The corpus must be captured from real Notion (a hand-written fake re-bakes the blind spot that let these bugs through), replayable offline so it gates every change, and periodically refreshed-and-diffed against live Notion so Notion-side drift surfaces deliberately rather than silently.
- **R36 Measurable simplicity bar:** The realized surface must satisfy a measurable simplicity bar as an acceptance gate: a bounded verb count, a bounded flag count, the number of mental-model concepts a user must hold to use the common path, and steps-to-first-success. Meeting the bar — together with a zero-result adversarial footgun pass (R30) — is a release gate, not advisory. The concrete thresholds and the winning surface are an output of the design bake-off (see spec.md), but the bar itself is a fixed requirement.
