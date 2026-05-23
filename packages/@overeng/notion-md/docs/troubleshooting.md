# Troubleshooting

## Missing Token

Symptom:

```text
NOTION_TOKEN is required
```

Fix:

```sh
export NOTION_TOKEN="secret_..."
```

Use a token whose integration has access to the target page.

## Page Not Found Or Unauthorized

If credentials are present but the page cannot be read, share the page with the
Notion integration. Notion returns similar failures for missing pages and pages
outside the integration's permissions.

## Frontmatter Parse Failure

Symptoms include `NmdFrontmatterError` or messages about strict `.nmd`
frontmatter.

Common causes:

- the opening or closing `---` marker was removed,
- the JSON frontmatter became invalid,
- a field was added that the schema does not allow,
- a tagged value was rewritten without `_tag`.

Fix the frontmatter from the schema, restore the file from version control, or
run `pull` again into a fresh file and reapply body edits.

## Object Store Error

Symptoms include `NmdObjectStoreError`, missing object paths, hash mismatches, or
inventory mismatches.

The `.nmd` file references immutable evidence under `.notion-md/objects`. Restore
the referenced objects from version control or pull the page again into a clean
file. Do not patch object hashes by hand.

## Body Conflict

Symptom:

```text
Remote page changed since the last clean pull
```

The CLI writes a Roughdraft conflict artifact beside the `.nmd` file when it has
base, local, and remote evidence. Inspect base/local/remote sections, edit the
`.nmd` body to the intended final content, then rerun:

```sh
notion-md status notes.nmd
notion-md push notes.nmd
```

Use `--force` only when overwriting the remote body is the intended outcome.

## Unknown Blocks Block Push

Normal push refuses to delete unsupported Notion blocks. Pull again if the remote
page has changed, or explicitly allow deletion:

```sh
notion-md push notes.nmd --allow-delete-unknown-blocks
```

Use the flag only when the unknown blocks are no longer needed.

## Roughdraft Markup Blocks Push

Normal push refuses unresolved Roughdraft review markup so review annotations do
not accidentally become visible Notion content.

Resolve or remove the markup before pushing. Use `--allow-review-markup` only
when the literal markup should be pushed.

## Watch Emits Repeated Errors

`sync --watch` recovers from sync errors and keeps running. Repeated
`sync_error` events usually mean the file needs manual action: conflict
resolution, token repair, object restore, or unknown-block deletion approval.

Stop the watcher, fix the file, confirm with `status`, then restart watch mode.
