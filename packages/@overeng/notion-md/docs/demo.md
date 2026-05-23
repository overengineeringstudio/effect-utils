# Demo Fixture

The package includes a durable local Notion Markdown fixture:

```text
packages/@overeng/notion-md/demo/showcase.nmd
packages/@overeng/notion-md/demo/.notion-md/objects/sha256/...
```

It syncs with this Notion page:

https://www.notion.so/overeng-notion-md-demo-automated-369f141b18dc80e4850cff344ad5b48e

The fixture demonstrates the intended local shape:

- a human-editable `.nmd` file,
- strict frontmatter generated from Notion,
- a stock Notion enhanced Markdown body,
- content-addressed base evidence under `.notion-md/objects`,
- clean `status` against the remote page after a successful pull.

## Verify

```sh
export NOTION_TOKEN="secret_..."
notion-md status packages/@overeng/notion-md/demo/showcase.nmd
```

A clean fixture reports:

```json
{
  "localChanged": false,
  "remoteChanged": false,
  "remoteBodyChanged": false
}
```

## Edit

Edit only the Markdown body unless you intentionally want to exercise
frontmatter property writes.

```sh
notion-md push packages/@overeng/notion-md/demo/showcase.nmd
notion-md pull 369f141b18dc80e4850cff344ad5b48e --out packages/@overeng/notion-md/demo/showcase.nmd
```

Pull after a successful push to commit Notion's normalized enhanced Markdown and
the new base snapshot.
