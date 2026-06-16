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

## Canonical Body Form (one function, both boundaries)

Decision [0019](../.decisions/0019-one-canonical-body-at-both-wire-boundaries.md).

There is **one renderer** (`treeToMarkdown`) and **one canonicalizer**
(`canonicalizeBlockMarkdown`, in `@overeng/notion-effect-client` beside the
renderer). Both Notion wire boundaries route the body through the canonicalizer,
so the body a surface reads (`cat`/`edit`/file sync), the body hashed/compared,
and the body pushed are the **same canonical bytes**:

- **Pull receive** canonicalizes at the source: `observeFromSnapshots`
  canonicalizes the rendered body once, before it feeds the inventory, the
  fidelity classifier, and the evidence fingerprint — so all of them agree by
  construction.
- **Push send** (`replace_content`) canonicalizes the same way.

The renderer emits *parseable-not-canonical* Markdown (it joins sibling blocks
with `\n\n` so they survive a reparse) and carries no spacing policy; the
canonical layer owns spacing/list-tightness (it forces `spread = false` on lists,
so a tight Notion list does not pull as a loose CommonMark list, and the stray
indented blank line inside nested lists is removed). Hosted-media URL
canonicalization (above) is a sub-step. `semanticEquivalent` (the push gate) is
whitespace-insensitive outside fenced code and is invariant across this — it
already masked the prior pull-loose / push-tight divergence.

## Push Strategy (fidelity intersection)

Refuse-lossy is what makes the **server-side `replace_content` push** safe: because
the page is refused unless its body is fully representable (decision 0016), the body
goes through Notion's own `replace_content` parser server-side
(`replaceRemoteBodyVerified`) with no block-level reconciliation and no client-side
Markdown→block converter — and since the body contains no opaque blocks,
`replace_content` can never destroy one (decision 0017).

The guarded-push engine that owns `replace_content` vs `update_content` selection,
the canonical base, the post-push `semanticEquivalent` gate, and settle/re-pull is
[03-sync-engine](../03-sync-engine/spec.md#update_content-vs-replace_content); that
gate runs with the hosted-media URL canonicalization owned here (decision 0007). The
surface framing — `put` as a guarded body replace plus a typed title write, two
writes body-first, partial-write reporting (decision 0017, decision 0012) — is in
[01-editor](../01-editor/spec.md#edge-behavior) and the file path in
[02-file-sync](../02-file-sync/spec.md).

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
