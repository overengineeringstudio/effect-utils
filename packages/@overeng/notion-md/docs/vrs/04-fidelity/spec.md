# Spec: 04-fidelity

Specifies the body-fidelity layer: the sound round-trip-safety classifier, the
uniform lossy-page refusal at the pull, the feature-mapping fidelity table, the
guarded server-side push strategy (no lossy client-side reconstruction), and
hosted-media URL canonicalization. Builds on
[../requirements.md](../requirements.md) and [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the architecture
index.

Traces: R12, R30, R31, R36, R38, R40, R41. This is the deliberately **shared**
layer: the editor pipes ([01-editor](../01-editor/spec.md)), the file path
([02-file-sync](../02-file-sync/spec.md)), and the engine
([03-sync-engine](../03-sync-engine/spec.md)) that both call all depend on it. The
refusal is enforced at the pull on every surface.

## Refusing Lossy Pages (uniform)

Requirement trace: R12, R38, Success Criterion 4. Decisions [0016](../.decisions/0016-refuse-lossy-pages.md), [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md).

The editor serves the **representable-Markdown majority** and refuses the rest.
A page whose body contains any **not-losslessly-representable block** is refused
(exit 3) **at the pull** — uniformly across `cat`, `put`, and `edit` (and the
file-based `sync`, which refuses at the same gate). Refusal is a property of the
shared core, not a streaming-only carve-out: `edit` materializes through the same
`pullPage` whose `assertRemoteMarkdownComplete` gate fires the refusal (decision
0017), so it refuses the same pages the pipes do.

The refusal criterion is **"not losslessly round-trippable"** — broader than the
API `unsupported` type. It covers `unsupported` plus known-but-lossy blocks:
`child_database` (renders `[embedded db]()`), `synced_block`,
`table_of_contents`, `breadcrumb` (renders `''`), `child_page`, and similar. The
body-fidelity classifier (`@overeng/notion-core`), which today flags only
`unsupported`, must be extended to flag every such block (R38, impl-delta Group
C). This is a **correctness prerequisite for the file path too**: today
`child_database`/`toc` classify `complete`, so without the extension a
`replace_content` push (file `sync` or `edit`) would silently destroy them.

- **Refusal, not placeholdering.** The reconciler/placeholder approach (former
  decisions 0005/0011) was abandoned: Notion's platform bars the parts of it that
  matter — no backlink endpoint (a moved `synced_block` original silently breaks
  inbound references), `child_database` is uncreatable via the block API, and the
  Markdown endpoint is non-injective. Refusing is the honest, elegant scope the
  platform permits (decision 0016).
- **Message.** The exit-3 error names the offending block class and points the
  user to the **Notion UI** to edit that block. The refusal is shared with the
  file-based `sync` (same pull gate), so it is not a workaround to switch to
  `sync` for these blocks.
- **Representable majority.** A page of paragraphs, headings, lists, to-dos,
  quotes, code, callouts, toggles, tables, columns, equations, and **hosted or
  external media** (media is representable — only its URL is volatile, decision 0007) round-trips cleanly and is fully editable.
- **Out-of-band preservation is for _round-trip-safe_ captures, not a lossy
  escape hatch.** The file path's `unsupported_blocks` + object-store machinery
  (Feature Mapping) captures files, media, and resolvable payloads on pages that
  classify _complete_. Post-R38 **no page containing a not-round-trip-safe block
  classifies `complete`** — such pages are refused at the pull on every surface —
  so that machinery never applies to a not-round-trip-safe body block. The
  pre-R38 "preserve any unsupported body block + `allow_deleting_content`
  override" behavior is retired: live testing proved it silently corrupts
  ([../experiments.md](../experiments.md)). Lossy pages are edited in Notion.

## Hosted-Media References

Requirement trace: R10, R36. Decision [0007](../.decisions/0007-canonicalize-hosted-media-urls.md). Live-validated in [../experiments.md](../experiments.md).

Notion-hosted media (image/file/video/pdf with `type: "file"`) renders with an
expiring signed S3 URL (`X-Amz-*`) that **rotates on every pull**. Left raw, it
makes the body hash volatile (breaking `cat`→`put` idempotence and staling base
hashes with zero edits) and causes `update_content` pushes on media pages to be
rejected by the post-push gate.

- Hosted-media URLs are **canonicalized** — strip the `X-Amz-*` / signature /
  `Expires` query params, keep `origin + pathname` — at **every** point a body
  is hashed, diffed, base-tracked, or gated, **including inside
  `semanticEquivalent` / `canonicalizeBlockMarkdown`**.
- External (stable) URLs are left untouched and pushed as external media.
- The canonicalized URL is deterministic but not directly fetchable; acceptable
  for an editing surface (the user edits text, not media URLs). Canonicalization
  governs hashing/diffing/gating only; the live file stays authoritative on the
  remote.

The pipe base hash ([01-editor](../01-editor/spec.md#guard-plumbing)) and the
engine's base snapshot ([03-sync-engine](../03-sync-engine/spec.md)) both depend on
this canonicalization for idempotence.

## Push Strategy and Canonical Base

Because the page is refused unless its body is fully representable (decision
0016), the stateless `put` is a **guarded body replace plus a typed title write**
— no block-level reconciliation, no client-side Markdown→block converter, no
stateless property write (decision 0017). The body goes through Notion's own
`replace_content` parser server-side (`replaceRemoteBodyVerified`); since the
body contains no opaque blocks, `replace_content` can never destroy one. (`edit`
takes a different path — it reuses the file engine's guarded push; see
[03-sync-engine](../03-sync-engine/spec.md) and [01-editor](../01-editor/spec.md#edit-session).)

- `put` writes the body via `replaceRemoteBodyVerified` (guarded by the base
  hash), then the title via the typed page API — **two writes, body first**
  (decision [0012](../.decisions/0012-non-atomic-title-body-write-order.md)). `put` has no `--frontmatter`; writable-property editing is
  `edit --frontmatter` or the file-based `sync`.
- A partial failure (one write landed, the other failed) reports which landed and
  exits 10; this dominates the exit-9 post-push gate (decision 0012).
- The post-push `semanticEquivalent` gate runs with hosted-media URL
  canonicalization (decision 0007).
- **Base = the canonical body, and only ever the value `cat` emitted.** Notion
  canonicalizes lists, ordered-list counters, code-fence language, and blank
  lines at write time, so the editor adopts the canonical body returned by the
  first pull as the base. The base hash is the value `cat` printed to stderr; a
  client must **never** recompute it locally over the editable buffer (which is
  pre-canonical until the next pull).

## Feature Mapping

Requirement trace: R01-R05.

| Notion feature                        | Local body representation        | Non-body state                  | Fidelity / policy                                                          |
| ------------------------------------- | -------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Page title/icon/cover                 | not body                         | frontmatter page fields         | title preserved; icon/cover modeled                                        |
| Page lock/trash state                 | not body                         | frontmatter page fields         | field-level page API patch                                                 |
| Paragraphs, headings, lists           | stock Markdown/enhanced Markdown | none                            | supported with Notion normalization                                        |
| To-dos, quotes, dividers              | stock Markdown/enhanced Markdown | none                            | supported                                                                  |
| Code blocks                           | fenced blocks                    | language normalization          | supported; aliases may normalize                                           |
| Equations                             | Markdown/enhanced math syntax    | raw rich-text fallback if lossy | block supported; inline conservative                                       |
| Callouts, toggles, tables             | enhanced Markdown tags           | color/attribute normalization   | supported with normalization caveats                                       |
| Columns                               | enhanced column tags             | none                            | supported by endpoint, needs coverage                                      |
| Images/files/media                    | Markdown/enhanced media tags     | future file payloads            | not fully implemented                                                      |
| Bookmark/embed/link preview           | not round-trip-safe in the body  | —                               | **refused at pull** (R38) — edit in Notion                                 |
| Child page/database **block in body** | not round-trip-safe in the body  | —                               | **refused at pull** (R30/R38)                                              |
| Child page **as a tree node**         | own `.nmd` file (tree)           | tree membership                 | preserved by the file-based tree engine (not a body block)                 |
| Data-source row properties            | not body                         | typed property map              | modeled writable properties ([06-data-source](../06-data-source/spec.md))  |
| Data-source schema/views              | not body                         | future schema snapshot          | not implemented                                                            |
| Comments                              | not body                         | future comment bridge           | not implemented                                                            |
| Suggestions/review                    | Roughdraft local layer           | review state                    | reject unresolved by default ([03-sync-engine](../03-sync-engine/spec.md)) |

Known Notion enhanced Markdown limitations:

- Notion normalizes valid Markdown on pull.
- Page title and properties are not included in Markdown body output.
- Some blocks pull as `<unknown>` with `unknown_block_ids`.
- The Markdown endpoint can return a prefix of the rendered block tree, such as
  content before a divider; that response is lossy and cannot become a clean
  `.nmd` base.
- The Markdown endpoint can omit separators around block boundaries; the clean
  pull body is rendered from the block tree so paragraphs adjacent to headings
  and dividers keep their block type.
- Signed file URLs expire and are not durable identity.
- Comments support inline Markdown-like content but are separate from body Markdown.
- A block whose body-Markdown rendering does not reparse to the same block
  (`[TOC]`, `[embedded db]()`, degraded bookmark, …) is **refused at pull** (R38),
  because a push would silently re-create it as a paragraph ([../experiments.md](../experiments.md)).
- `allow_deleting_content` can delete resolvable unknown blocks and tree child
  pages/databases; the default is non-destructive. It is not an escape hatch for
  not-round-trip-safe body blocks, which are refused before any push.

Evidence for these limitations lives in [../experiments.md](../experiments.md).
