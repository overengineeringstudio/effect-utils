# Spec: notion-md — architecture index

This is the top-level architecture index for `@overeng/notion-md`. It builds on
[requirements.md](./requirements.md); terms are in [glossary.md](./glossary.md)
(inherited downward by every subsystem); the hard-to-reverse rationale is in
[.decisions/](./.decisions/), cited by relative path. The per-subsystem `spec.md`
files carry the detailed design; this page holds only Status, Scope, the system
shape + dependency diagram, the subsystem index, and the cross-cutting
OpenTelemetry, Verification, and residual long-term-decision lists. Evidence lives
in [experiments.md](./experiments.md); the spec-vs-implementation gap in
[impl-delta.md](./impl-delta.md).

## Status

Draft -- the implemented `@overeng/notion-md` package covers the core body/property
sync path, strict `.nmd` frontmatter, content-addressed local state, guarded
push/sync/watch behavior, batch multi-file and recursive folder orchestration,
Effect Platform file watching, and live Notion E2E coverage. The `$EDITOR`-based
editor surface (`cat`/`put`/`edit`), the uniform lossy-page refusal, hosted-media
canonicalization, and the schema-drift guard are designed and partly landed (see
[impl-delta.md](./impl-delta.md)). The staged write-path sync-progress indicator
([01-editor](./01-editor/spec.md#sync-progress-indicator-write-path)) is designed,
not yet implemented. File bytes, comment projection, and webhook delivery are
designed surfaces that remain outside the implemented core. Full data-source sync
is owned by the standalone [Notion datasource sync spec](../../../notion-datasource-sync/docs/vrs/spec.md).

## Scope

Defines (across the subsystem specs): the `.nmd` local file contract and the
`.notion-md` content-addressed local state store; the `$EDITOR`-based editor
surface and the write-path progress indicator; sync surfaces and guarded conflict
policy; the shared fidelity classifier and uniform lossy-page refusal; CLI, batch,
and watch behavior; the typed property / page-metadata surface and schema-drift
guard; Effect service boundaries; OpenTelemetry conventions; verification
expectations and known limitations.

Does not define:

- a generic Notion renderer,
- a rich text editor,
- a full offline Notion clone,
- a replacement syntax for Notion enhanced Markdown,
- full data-source schema/view sync (see the [Notion datasource sync spec](../../../notion-datasource-sync/docs/vrs/spec.md)).

## Boundary with the official `ntn` CLI

This tool layers guarded body/page editing and multi-page subtree sync **on top
of** Notion's official `ntn` CLI; it does not re-implement `ntn`'s surface. We
add a command on a surface `ntn` already covers only with a documented clear
reason — a safety, fidelity, library-reuse, or scope property `ntn` lacks. The
per-command audit and the clear reasons live in
[decision 0021](./.decisions/0021-avoid-duplicating-official-ntn.md); raw
datasource queries, `api`, `files`, and `login` stay `ntn`'s.

### DQ1 — `cat` vs `ntn pages get`

`cat` overlaps `ntn pages get`; its only edge is base-hash emission for the
guarded `put` workflow plus refuse-on-read, and it is weaker than `ntn pages get`
for casual reads. Whether `cat` stays a user-facing guarded-workflow read
primitive or is deprecated toward `ntn pages get` is an open question — see
[open-questions.md `OQ1`](./open-questions.md#oq1--keep-cat-or-defer-casual-reads-to-ntn-pages-get).

## System Shape

```
notion-md CLI                          notion edit <page>  (umbrella alias)
  |                                       |
  |  pull/status/push/sync/watch/batch    |  cat/put/edit (editor surface)
  v                                       v
Batch/tree orchestrator  ────────►  Editor surfaces (01-editor)
  | discovery, dup page-id, concurrency     | cat/put: gateway-only body pipes
  v                                         | edit: ephemeral $TMPDIR file-engine session
Sync coordinator (02-file-sync) ◄───────────┘
  |
  v
Sync engine (03-sync-engine): guarded push · 3-way merge · update/replace selection · canonical base · post-push gate · settle · review guard
  |
  +── depends on ──► Fidelity (04-fidelity): classifier · uniform lossy refusal · media canonicalization
  |
  +── reads/writes ─► Local state (05-local-state): .nmd envelope · object store · base snapshots
  |
  +── projects ─────► Data source (06-data-source): writable props/metadata · schema_snapshot drift
  |
  +── Local .nmd file
  +── .notion-md/objects/sha256/<hash>.json
  +── Notion Markdown endpoint · page/property APIs · block API
  +── Future: comments, files, data-source schema, webhooks
```

Requirement trace: R01-R05, R16-R24.

The system treats Notion enhanced Markdown as one sync surface, not the whole page.
The body surface is stock Notion enhanced Markdown. Local metadata, page
properties, unsupported block preservation, files, comments, and review state are
modeled outside the body so they are never silently sent as Notion Markdown.

**Effect service boundaries** (R16-R20). The CLI program provides the command
tree, option schemas, and output renderers. The sync coordinator (depends on
`NotionGateway` + `NmdStateStore`) owns pull/status/push/sync decisions. The
`NotionGateway` (depends on `NotionConfig` + `HttpClient`) owns typed Notion API
calls and response adaptation. The `NmdStateStore` (depends on `FileSystem` +
`Path`) owns `.nmd` IO, object refs, object validation, and atomic local writes.
The merge planner is a pure module. The watch service owns the event queue,
debounce, polling, and scoped cancellation. The `ProgressReporter` service
(`Context.Tag`, no-op default Layer) carries write-path stage events
([01-editor](./01-editor/spec.md#sync-progress-indicator-write-path), R45).
Untrusted payloads decode through Effect Schema at the boundary; expected failures
use tagged errors with page/file/surface context; long-lived watch resources are
scoped and interruptible; pure planning logic stays outside services with focused
unit tests.

The public body facade exposes body-only observe, local read, materialize,
verified remote replace, and clean-base settlement operations for adapters that
compose with `.nmd` files (the `cat`/`put` engine). The facade depends on
`NotionMdGateway` and `NmdStateStore`; it does not expose sync coordinator
decisions or page-metadata mutation as an adapter surface. Remote body
observations carry `@overeng/notion-core` body-completeness evidence produced by
`@overeng/notion-effect-client` live observation; `notion-md` turns that evidence
into clean-base policy and refuses to treat a lossy observation as a clean `.nmd`
base ([04-fidelity](./04-fidelity/spec.md)).

### Sync surfaces map

Requirement trace: R01-R05, R11-R15.

| Surface                                  | Local state                    | Pull API                              | Push API                                                 | Owner                                                      |
| ---------------------------------------- | ------------------------------ | ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Body                                     | `.nmd` body + `base_snapshot`  | block-tree render + endpoint evidence | Markdown update endpoint                                 | [03](./03-sync-engine/spec.md)/[04](./04-fidelity/spec.md) |
| Page metadata                            | frontmatter page fields        | `GET /pages/{id}`                     | `PATCH /pages/{id}`                                      | [06-data-source](./06-data-source/spec.md)                 |
| Properties                               | frontmatter property map       | `GET /pages/{id}`                     | `PATCH /pages/{id}`                                      | [06-data-source](./06-data-source/spec.md)                 |
| Unsupported / not-round-trip-safe blocks | frontmatter/object storage     | Markdown + block API                  | refuse at pull (R38); round-trip-safe captures preserved | [04-fidelity](./04-fidelity/spec.md)                       |
| Data-source schema                       | external datasource-sync state | datasource-sync package               | datasource-sync package                                  | datasource-sync                                            |
| Comments                                 | future comment payload         | comments API                          | comments API                                             | (designed)                                                 |
| Files                                    | future file payload            | block/file APIs                       | file upload APIs                                         | (designed)                                                 |
| Review                                   | Roughdraft local markup        | local only or comments API            | explicit bridge only                                     | [03-sync-engine](./03-sync-engine/spec.md)                 |

## Subsystem index

The `0N` prefix encodes reading + dependency order (`0N` may depend on lower
numbers, not the reverse). The decomposition is **layered**: the two surfaces
(01-editor, 02-file-sync) sit on a shared engine (03-sync-engine) that depends on
the shared fidelity layer (04-fidelity), durable local state (05-local-state), and
the typed property surface (06-data-source). Each subsystem `spec.md` opens with a
link up to [../requirements.md](./requirements.md) + its own `requirements.md`.

| #   | Subsystem                               | Spec covers                                                                                                                                                                                        | Requirements                          | Decisions                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| 01  | [editor](./01-editor/spec.md)           | `cat`/`put`/`edit` surfaces, representation modes, title↔H1 boundary, guard plumbing, exit codes, `edit` session, umbrella, sync-progress indicator                                                | R32, R33, R34, R35, R37, R39, R43–R45 | 0001, 0002, 0003, 0004, 0008, 0009, 0012, 0017, **0018** |
| 02  | [file-sync](./02-file-sync/spec.md)     | pull/status/push flows, CLI + batch/tree orchestration, watch lifecycle                                                                                                                            | R20, R28                              | (traces 0017)                                            |
| 03  | [sync-engine](./03-sync-engine/spec.md) | guarded push, 3-way Markdown merge, `update_content`/`replace_content` selection, canonical base, post-push `semanticEquivalent` gate, settle-and-re-pull, review-safety guard, force escape hatch | R09, R11, R13, R15                    | 0002, 0007, 0009, 0012, 0016, 0017                       |
| 04  | [fidelity](./04-fidelity/spec.md)       | sound round-trip classifier, uniform lossy-page refusal, feature mapping, server-side push strategy, hosted-media canonicalization                                                                 | R12, R30, R31, R36, R38, R40, R41     | 0005, 0007, 0010, 0011, 0014, 0015, 0016                 |
| 05  | [local-state](./05-local-state/spec.md) | `.nmd` envelope, frontmatter schema, `.notion-md/` content-addressed object store, base snapshots                                                                                                  | R06, R07, R08, R10                    | 0006                                                     |
| 06  | [data-source](./06-data-source/spec.md) | writable property values, writable page metadata, `data_source` binding, `schema_snapshot` schema-drift guard                                                                                      | R04, R14                              | 0013                                                     |

The `.decisions/` directory (0001–0021) is the authoritative decision log; the
Decisions column above is the citation map. Decision **0021** (avoid duplicating
the official `ntn` CLI) is cross-cutting — it constrains the whole command surface
rather than one subsystem — and is cited from the "Boundary with the official
`ntn` CLI" section above. Decision **0016** (refuse lossy pages)
supersedes the reconciler/converter records (0005, 0010, 0011, 0014, 0015);
decision **0017** (edit = ephemeral file-engine session) supersedes 0013 (the
stateless schema fingerprint) and broadens the refusal to uniform; decision
**0018** adds the staged write-path sync-progress indicator.

**Cross-cutting at root by design.** Observability (the OpenTelemetry conventions),
verification expectations, and the Effect service-boundary overview deliberately
stay at this root index rather than living in a subsystem: the 6-way split is by
sync surface and correctness layer and has no observability/testing subsystem to own
them, and each spans all six. A future `07-observability` subsystem could own the
OTEL + verification surface if it grows enough to warrant its own requirements; that
is a possible follow-up, not done now.

## OpenTelemetry (cross-cutting)

Requirement trace: R21-R24, R29.

Service names:

| Mode         | `service.name`    |
| ------------ | ----------------- |
| CLI one-shot | `notion-md-cli`   |
| Watch mode   | `notion-md-watch` |

Current implementation uses `notion-md-cli` for both modes and distinguishes watch via attributes. Future process/resource configuration should split them.

Span conventions:

| Span                                | Required attributes                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion-md.cli.<command>`           | `span.label`, `notion_md.command`                                                                                                                                                              |
| `notion-md.cat`                     | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`                                                                                                                                     |
| `notion-md.put`                     | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`, `notion_md.put.force`, `notion_md.put.body_written`, `notion_md.put.title_written`                                                 |
| `notion-md.edit`                    | `span.label`, `notion_md.page_id`, `notion_md.editor.mode`, `notion_md.edit.outcome`; wraps the engine's `notion-md.sync-page` / `push-page` / `status-page` spans as children (decision 0017) |
| `notion-md.sync-page`               | `span.label`, `notion_md.sync.result`, `notion_md.page_id`                                                                                                                                     |
| `notion-md.status-page`             | local/remote changed booleans, unknown-block count                                                                                                                                             |
| `notion-md.push-page`               | force flag, destructive flag, push decision, markdown command                                                                                                                                  |
| `notion-md.watch.sync-pass`         | watch reason, command, path basename, error tag when failed                                                                                                                                    |
| `notion-md.gateway.update-markdown` | page id, update type, content-update count, destructive flag                                                                                                                                   |
| `notion-md.state.read-object`       | object role, hash prefix                                                                                                                                                                       |
| `notion-md.state.write-object`      | object role, hash prefix                                                                                                                                                                       |

Attributes must not include tokens, full Markdown bodies, file bytes, or signed
URLs — asserted by a span leak-guard test (R24, Group G). All attribute keys use
the `notion_md.*` namespace (not a `nmd.*` shorthand). The write-path stage
vocabulary ([01-editor](./01-editor/spec.md#sync-progress-indicator-write-path)) is
a CLI-facing presentation contract, distinct from these span names. A
`result`/`changed`/`partial_write` attribute per command is desirable hardening not
yet emitted (impl-delta Group G follow-up).

## Verification (cross-cutting)

| Layer           | Required coverage                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| Unit            | schemas, canonicalization, merge planner, hash stability, object refs             |
| Fake E2E        | pull/status/push/sync/watch, property/body concurrency, unknown-block guards      |
| State integrity | corrupt hashes, stale objects, path traversal, inventory mismatch, legacy rejects |
| Live Notion E2E | pull/status/push, stale overwrite rejection, unknown blocks, merge, property edit |
| CLI             | command parsing, invalid options, missing token, output contracts                 |
| OTEL            | expected spans and safe attributes                                                |

Implemented verification currently includes:

- pure merge planner tests,
- fake-gateway E2E tests,
- live Notion E2E against a configured parent page,
- live E2E ledger updates on the configured parent page,
- a durable automated demo page synced from `packages/@overeng/notion-md/demo/showcase.nmd`,
- a flat recursive batch demo template under `packages/@overeng/notion-md/demo/workspace/`,
- local `check:quick` and `check:all`.

Live E2E uses `NOTION_TEST_PARENT_PAGE_ID` as a scratch parent. Test-created
child pages are archived during teardown. A stable `notion-md e2e run ledger`
child page records the latest live run so the parent page remains visibly tied
to the test suite without retaining every scratch fixture.

The automated demo page is not a test scratch page. It is the durable 1:1
showcase for local `.nmd` and Notion state. Its local file and reachable object
store entries are committed under `packages/@overeng/notion-md/demo/`.

The batch demo is intentionally a template, not another live fixture set.
Checked-in examples use `.nmd.example` so recursive commands only operate after a
user has pulled distinct real Notion pages into `.nmd` files.

Follow-up hardening remains for required live-lane policy, OTEL span assertions,
versioned CLI output schemas, broader storage/comment coverage, and the staged
sync-progress indicator (decision 0018). Watch coverage already includes polling,
structured errors, and batch coalescing in the fake/live E2E suite; additional
watch work should target uncovered lifecycle or timing edges rather than restating
the basic watch-core scenarios.

## Residual long-term decisions (cross-cutting)

The editor decisions are recorded as individual records in
[`.decisions/`](./.decisions/) (0001–0018) — that directory is the authoritative
decision log. The residual file-based-engine areas below have no individual record
and are summarized here; they must not silently diverge from the records.

| Area                        | Decision                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline equations            | Treat inline equations conservatively until raw rich-text evidence proves Notion's Markdown endpoint preserves equation semantics. If not, preserve spans outside the body. |
| Page/data-source references | Use stock enhanced Markdown where Notion round-trips references. Preserve unsupported references with block API snapshots and object refs.                                  |
| Property merge bases        | Keep compact bases inline; move large or volatile bases into content-addressed objects by policy.                                                                           |
| Comment anchoring           | Bridge Roughdraft comments only when exact selected text is unique in a known block; otherwise fall back to page-level comments.                                            |
| Store index                 | Derive reachability from `.nmd` frontmatter and object refs. Add a JSON index only when repo-scale GC or multi-page watch needs it.                                         |
| Batch sync                  | Keep the page/file sync engine as the correctness boundary. Batch and folder modes are orchestration only, with duplicate page-id preflight and per-file results.           |
| Body completeness           | Keep pure vocabulary in `@overeng/notion-core`, live observation in `@overeng/notion-effect-client`, and clean-base adoption/write policy in `@overeng/notion-md`.          |
| Pull body authority         | Adopt block-tree-rendered Markdown as the clean `.nmd` body; retain endpoint Markdown as diagnostic evidence for truncation, unknown blocks, and comparison.                |
| Webhooks                    | Polling remains the correctness baseline. A local daemon/tunnel may accelerate refresh; hosted relay is a separate product/security decision.                               |
| CLI output                  | Use explicit output modes with versioned envelopes. Watch mode uses NDJSON events.                                                                                          |
| Watch events                | Use Effect Platform streams plus a deterministic reducer/queue policy. Avoid raw `fs.watch` ownership in package code.                                                      |
