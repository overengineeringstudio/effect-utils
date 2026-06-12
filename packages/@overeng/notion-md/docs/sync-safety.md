# Sync Safety

`notion-md` is conservative by default. It preserves intent by separating sync
surfaces and refusing ambiguous writes.

## Surfaces

| Surface            | Local state                                        | Write behavior                       |
| ------------------ | -------------------------------------------------- | ------------------------------------ |
| Body               | `.nmd` body; base object only for `source: shared` | source-dispatched reconcile          |
| Page metadata      | frontmatter page fields                            | field-level patch for modeled values |
| Properties         | frontmatter properties                             | modeled writable values only         |
| Unsupported blocks | frontmatter/object store                           | preserve metadata or explicit delete |
| Review markup      | Roughdraft body markup                             | rejected unless explicitly allowed   |
| Files              | storage units                                      | modeled, upload/download incomplete  |
| Comments           | storage units                                      | modeled, bridge incomplete           |

## Body Direction And Conflicts

Each `.nmd` file declares an explicit `source`:

| Source   | State model           | Result when bodies differ                        |
| -------- | --------------------- | ------------------------------------------------ |
| `local`  | no base sidecar       | local body is mirrored to Notion                 |
| `remote` | no base sidecar       | local body is overwritten from Notion            |
| `shared` | base sidecar required | base, local, and remote are merged or conflicted |

Only `source: shared` uses base-backed three-way conflict handling. Conflict
artifacts are written beside the `.nmd` file using Roughdraft markup. Resolve by
editing the `.nmd` body to the intended final content, then rerun `status` or
`sync`.

## Body Completeness

`notion-md` only treats a remote body as clean local state when the body
observation is complete. The completeness vocabulary lives in
`@overeng/notion-core`; live Markdown plus block-tree observation lives in
`@overeng/notion-effect-client`; `notion-md` owns the fail-closed policy.

Clean-base adoption is blocked when Notion reports truncation, reports endpoint
unknown block IDs, the block inventory contains unsupported body content, or the
rendered block tree proves the Markdown endpoint omitted a suffix. This prevents
single-page establishment from silently writing a partial `.nmd` body when the
Markdown endpoint stops at a divider or another unsupported boundary.

The same rule applies after verified writes. Shared sync does not settle a fresh
base until the refreshed remote body observation is complete.

## Roughdraft Review Markup

Unresolved Roughdraft markers are local review state:

```markdown
{==old text==}{>>review note<<}{id="r1"}
```

Normal sync refuses to send these markers to Notion. Resolve or remove the
markers before syncing. The v-next CLI does not expose a review-markup override
flag until that destructive mode is implemented explicitly.

## Unknown Blocks

Some Notion blocks cannot be represented by the Markdown endpoint and appear as
unknown placeholders. `notion-md` records their block IDs and compact snapshots in
frontmatter or object storage.

Normal sync refuses body updates that could delete unresolved unknown blocks.
Model the unsupported surface or remove the local body edit before syncing. The
v-next CLI does not expose an unknown-block deletion override flag until that
destructive mode is implemented explicitly.

Notion-reported endpoint unknown block IDs also make a remote body unsuitable
as a clean base. This is separate from notion-md's self-contained storage path,
which can preserve some unsupported Notion blocks outside the Markdown body and
continues to block destructive body pushes until those placeholders are
resolved or deletion is explicitly allowed.

## Property-Only Edits

Property-only edits can be synced independently from body edits once their
surface is modeled as writable. They do not require treating every remote body
change as a shared body conflict.

## Page Metadata Edits

Page metadata edits are independent from body edits. `icon`, `cover`,
`in_trash`, and `is_locked` are patched through the page API and then refreshed
from Notion. The current writable subset is intentionally narrower than the
schema-preserved pull subset: external covers and null covers are writable,
emoji/native/external icons and null icons are writable, and Notion-hosted files
or custom emojis are preserved until their write behavior is proven.

## Object Integrity

`status` and `sync` validate referenced objects before trusting local
state. Tampered object bytes, missing objects, stale inventory, and invalid
logical paths fail early.

Do not edit `.notion-md/objects` by hand. If an object-store error appears, sync
again from the remote page id or restore the referenced object from version control.
