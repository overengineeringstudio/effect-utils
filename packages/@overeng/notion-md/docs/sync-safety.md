# Sync Safety

`notion-md` is conservative by default. It preserves intent by separating sync
surfaces and refusing ambiguous writes.

## Surfaces

| Surface            | Local state               | Push behavior                        |
| ------------------ | ------------------------- | ------------------------------------ |
| Body               | `.nmd` body + base object | guarded Markdown update              |
| Page metadata      | frontmatter page fields   | partial support                      |
| Properties         | frontmatter properties    | modeled writable values only         |
| Unsupported blocks | frontmatter/object store  | preserve metadata or explicit delete |
| Review markup      | Roughdraft body markup    | rejected unless explicitly allowed   |
| Files              | storage units             | modeled, upload/download incomplete  |
| Comments           | storage units             | modeled, bridge incomplete           |

## Body Conflicts

Every pull writes a base snapshot. Push compares base, local, and remote bodies:

| Case                       | Result                  |
| -------------------------- | ----------------------- |
| local changed, remote same | push local body         |
| local same, remote changed | pull remote body        |
| both changed, no overlap   | auto-merge and push     |
| both changed, overlap      | write conflict artifact |
| remote changed + `--force` | overwrite remote body   |

Conflict artifacts are written beside the `.nmd` file using Roughdraft markup.
Resolve by editing the `.nmd` body to the intended final content, then rerun
`status` or `push`.

## Roughdraft Review Markup

Unresolved Roughdraft markers are local review state:

```markdown
{==old text==}{>>review note<<}{id="r1"}
```

Normal push refuses to send these markers to Notion. Use
`--allow-review-markup` only when you deliberately want the markers to become
visible Notion content.

## Unknown Blocks

Some Notion blocks cannot be represented by the Markdown endpoint and appear as
unknown placeholders. `notion-md` records their block IDs and compact snapshots in
frontmatter or object storage.

Normal push refuses body updates that could delete unresolved unknown blocks. Use
`--allow-delete-unknown-blocks` only after deciding that deleting those Notion
blocks is acceptable.

## Property-Only Edits

Property-only edits can be pushed even when the remote body changed. The CLI
patches the property surface, then refreshes the local body and base from the
current remote body. This avoids turning independent property and body edits into
a false conflict.

## Object Integrity

`status`, `push`, and `sync` validate referenced objects before trusting local
state. Tampered object bytes, missing objects, stale inventory, and invalid
logical paths fail early.

Do not edit `.notion-md/objects` by hand. If an object-store error appears, pull
again from the remote page or restore the referenced object from version control.
