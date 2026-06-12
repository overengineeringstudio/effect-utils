# Source is explicit in v-next frontmatter

v-next `.nmd` frontmatter requires an explicit `source` value. Missing `source`
is not defaulted to `local`, because a legacy bound file must not silently become
local-authoritative and overwrite Notion.

## Status

accepted

## Consequences

`track`, templates, and migration/import paths must write `source` explicitly.
`track` may default its `--as` option to `remote`, but the resulting file still
contains `"source": "remote"`. The schema rejects missing `source` for v-next
files.
