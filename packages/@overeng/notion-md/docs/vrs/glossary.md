# Notion Markdown Sync — Glossary

This glossary defines the domain language for notion-md's sync model and editor
surfaces. It covers concepts used by the VRS and implementation; generic Effect,
CLI, and Markdown terms are intentionally omitted.

## Language

**Source**:
The frontmatter field that declares which sync mechanism and authority policy a
file uses. Valid values are `local`, `remote`, and `shared`.
_Avoid_: mode, direction flag

**Tracked Page**:
A Notion page bound to a local `.nmd` file through explicit frontmatter identity
and Source. Tracking is established by `track`.
_Avoid_: cloned page, imported page

**Tracked Tree**:
A Notion root page and its child-page hierarchy bound to one local directory.
Each page retains its own `.nmd` frontmatter identity; the Tree Manifest declares
the hierarchy's authority and routes directory operations.
_Avoid_: recursive batch, folder sync

**Tree Manifest**:
The regenerable `.notion-md/workspace.json` routing and prior-ownership index for
a Tracked Tree. It records the root, layout, authority, and last materialized
path-to-page mapping, but never supersedes `.nmd` frontmatter as page identity.
_Avoid_: identity store, source of truth

**Derived Child Link**:
A relative local Markdown link rendered from a direct Notion child-page anchor
inside a remote-authoritative Tracked Tree. It is local navigation, not authored
body content; the sync baseline retains the canonical Notion child anchor.
_Avoid_: user-authored child-file link

**Mirror Sync**:
The stateless mechanism for pages authored on exactly one side. `source: local`
mirrors local content to Notion; `source: remote` mirrors Notion content to the
local file.
_Avoid_: single-source guarded sync, one-way merge

**Shared Sync**:
The stateful mechanism for pages authored on both sides. It uses a Base Snapshot
for three-way merge and emits conflict artifacts when concurrent edits cannot be
resolved.
_Avoid_: bidirectional mode, two-way sync

**Authority**:
The side that wins when modeled content differs. A file derives authority from
`source`; a Tracked Tree derives it from the Tree Manifest. Local authority
mirrors local content to Notion, remote authority mirrors Notion into the local
surface, and `shared` is available only through per-file Source.
_Avoid_: winner flag, precedence

**Modeled Body**:
The Notion enhanced Markdown body surface that notion-md can render, compare,
and write with known fidelity. It excludes unsupported blocks, child pages,
comments, files, and local review metadata.
_Avoid_: whole page, all content

**Base Snapshot**:
The last clean body observation used by Shared Sync to distinguish local-only,
remote-only, and concurrent edits. Mirror Sync has no Base Snapshot.
_Avoid_: stored hash, checkpoint

**Semantic Equivalence**:
The relation used to decide whether local and remote bodies are in sync after
canonical normalization. It folds presentation-only differences while preserving
body-shape differences that affect Notion fidelity.
_Avoid_: byte equality, raw hash equality

**Body pipe** (`cat` / `put`):
The stateless stdin/stdout body commands that move a page body between Notion and
an editor or pipe with **no** `.nmd` file and **no** `.notion-md/` directory.
Gateway-only. The genuinely stateless surface. Distinct from [[Editor session]]
(`edit`, engine-backed) and the file surfaces (`track`, `status`, `sync`).
_Avoid_: streaming surface (it now spans the engine-backed `edit` too), pipe mode.

**Default mode**:
The representation that is plain Notion enhanced Markdown plus the page title
rendered as a leading [[Title H1]]. The everyday human-editing shape. Available
on `cat`, `put`, `edit`.
_Avoid_: body mode, simple mode.

**Frontmatter mode**:
The representation selected by `--frontmatter` that emits/accepts the full `.nmd`
envelope (strict JSON frontmatter with properties + body). Editable title and
writable properties; read-only properties pass through. Available on `cat`
(read) and `edit` (read/write); **not** on `put` (no stateless property write,
decision 0017).
_Avoid_: envelope mode, full mode, nmd mode.

**Title H1**:
The leading `# <title>` line in default mode. A **presentation** of the page
title, never body content. On write it is extracted to the typed page-title API
and stripped from the body. See decision 0001.
_Avoid_: heading title, body title.

**Presentation surface** vs **transport surface**:
Presentation is how a value is rendered for a human to edit (e.g. title as an
H1). Transport is the API/storage path a value actually syncs through (e.g.
title via the typed page-metadata API). A value may be presented one way and
transported another; R01/R03/R04 constrain transport, not presentation.

**Base hash**:
The content hash of the title + body a `cat` caller read, used as the optimistic-
concurrency token for a [[Guarded put]]. A [[Body pipe]] concept only; `edit`
uses the engine's base _snapshot_ instead. Trips on a concurrent change to title
or body.
_Avoid_: body hash (the base hash spans title too), etag.

**Guarded put**:
The default `put` behavior: re-read remote, compare against the caller's
[[Base hash]], and refuse (exit 7) if the remote moved. The pipe analogue of R11
guarded push.

**Force put**:
`put --force`: skip the [[Base hash]] guard (last-writer-wins). An explicit
destructive mode under R15; must report what it bypasses.

**Editor session** (`edit`):
One `edit` invocation as an **ephemeral file-engine session**: `mktemp -d` under
`$TMPDIR` → `pullPage` into a temp `.nmd` + `.notion-md/` → `$VISUAL`/`$EDITOR` on
the body → `syncPage` push → scope-clean the temp tree. Sugar over the file
engine, not a separate push path; guarded by the engine's base snapshot. Not
live/continuous sync. See decisions 0003, 0017.
_Avoid_: streaming edit, gateway-only edit (it is engine-backed).

**Opaque block** (unknown / not-losslessly-representable block):
A Notion block the body Markdown cannot fully represent — the API `unsupported`
type plus known-but-lossy blocks (`child_database`, `table_of_contents`,
`synced_block`, `child_page`, …). In code the unsupported-block snapshot schema
is `NmdUnsupportedBlockUnit` and the frontmatter field is `unsupported_blocks`
(there is no `NmdnUnit` / `n_blocks`). A page whose body contains one triggers a
[[Lossy-page refusal]] on every surface (`cat`/`put`/`edit`/`sync`). See
decisions 0016, 0017.
_Avoid_: unsupported block (the API's `unsupported` type is one source of these,
not the whole class); `n` block.

**Lossy-page refusal**:
The **uniform** behavior — across `cat`/`put`/`edit` and the file-based `sync` —
when a page's body contains an [[Opaque block]]: refuse the page (exit 3) at the
**pull** with a message naming the block and pointing to the Notion UI, rather
than risk silently dropping or corrupting content. Enforced by the shared
classifier gate (`assertRemoteMarkdownComplete`), not a streaming-only behavior.
See decisions 0016, 0017.
_Avoid_: lossy error, unsupported error, streaming refusal.

**Hosted media** vs **external media**:
Hosted media is an image/file/video/pdf block whose bytes Notion stores
(`type: "file"`), served via an **expiring signed URL** that rotates every pull.
External media references a stable third-party URL. Only hosted media needs
[[URL canonicalization]].

**URL canonicalization**:
Stripping the volatile signature/expiry query params (`X-Amz-*`, `Expires`) from
a [[Hosted media]] URL, keeping origin + path, wherever a body is hashed,
diffed, base-tracked, or gated. Makes media bodies idempotent and pushable. See
decision 0007.
_Avoid_: url stripping, url normalization (it is specifically the signed-param
strip).

**Guarded body replace**:
The **`cat`/`put`** push engine: write the edited body through
`replaceRemoteBodyVerified` (Notion's `replace_content`, guarded by the
[[Base hash]]) then the title through the typed page API — two writes, body
first. Not block-level reconciliation; lossy pages are refused first
([[Lossy-page refusal]]). `edit` does not use this — it reuses the file engine's
guarded push. See decisions 0012, 0016, 0017.
_Avoid_: reconciliation, block patch.

## Flagged Ambiguities

**Single-source**:
Historically meant "author on one side" and sometimes implied guarded writes.
Use Mirror Sync when referring to the stateless authoritative mechanism.

**Bidirectional**:
Historically described any sync that can move data both ways. Use Shared Sync
when referring to the stateful base-and-merge mechanism for concurrent authoring.
