# Sync Safety

`notion-md` is conservative by default. It preserves intent by separating sync
surfaces and refusing ambiguous writes.

## Surfaces

| Surface            | Local state               | Write behavior                       |
| ------------------ | ------------------------- | ------------------------------------ |
| Body               | `.nmd` body + base object | guarded Markdown update              |
| Page metadata      | frontmatter page fields   | field-level patch for modeled values |
| Properties         | frontmatter properties    | modeled writable values only         |
| Unsupported blocks | frontmatter/object store  | preserve metadata or explicit delete |
| Review markup      | Roughdraft body markup    | rejected unless explicitly allowed   |
| Files              | storage units             | modeled, upload/download incomplete  |
| Comments           | storage units             | modeled, bridge incomplete           |

## Body Conflicts

Every pull writes a base snapshot. Sync compares base, local, and remote bodies:

| Case                       | Result                  |
| -------------------------- | ----------------------- |
| local changed, remote same | write local body        |
| local same, remote changed | pull remote body        |
| both changed, no overlap   | auto-merge and write    |
| both changed, overlap      | write conflict artifact |
| remote changed + `--force` | overwrite remote body   |

Conflict artifacts are written beside the `.nmd` file using Roughdraft markup.
Resolve by editing the `.nmd` body to the intended final content, then rerun
`status` or `sync`.

## Roughdraft Review Markup

Unresolved Roughdraft markers are local review state:

```markdown
{==old text==}{>>review note<<}{id="r1"}
```

Normal sync refuses to send these markers to Notion. Use
`--allow-review-markup` only when you deliberately want the markers to become
visible Notion content.

## Unknown Blocks

Some Notion blocks cannot be represented by the Markdown endpoint and appear as
unknown placeholders. `notion-md` records their block IDs and compact snapshots in
frontmatter or object storage.

Normal sync refuses body updates that could delete unresolved unknown blocks. Use
`--allow-delete-unknown-blocks` only after deciding that deleting those Notion
blocks is acceptable.

## Property-Only Edits

Property-only edits can be synced even when the remote body changed. The CLI
patches the property surface, then refreshes the local body and base from the
current remote body. This avoids turning independent property and body edits into
a false conflict.

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
