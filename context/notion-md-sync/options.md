# Notion Markdown Sync Options And Decisions

Status: WIP decision note derived from the E2E research docs.

## Recommendation

Build the long-term version around `.nmd`: stock Notion enhanced Markdown body, strict local YAML frontmatter, and sidecar escalation for large or volatile state.

The guiding rule is simple:

- Stock Notion enhanced Markdown stays in the body.
- Local sync metadata and compact typed storage units stay in frontmatter.
- Bulky, volatile, or non-human-friendly state escalates to a sidecar.
- Roughdraft review state stays local unless explicitly bridged to Notion comments.

This gives us a principled, inspectable format without pretending that enhanced Markdown is a complete Notion document serialization.

## Format Options

| Option                           | Tradeoffs                                                                                                                                        | Recommendation                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `.nmd` with frontmatter          | Self-describing and easy to move as one file. Requires stripping frontmatter before push. Leading user-visible YAML needs escaping.              | Best default.                                                |
| Plain `.md` plus sidecar         | Body remains pure stock enhanced Markdown. Metadata can be lost when files move. Harder for humans and agents to understand a file in isolation. | Support later as lower-friction export mode.                 |
| Plain `.md` with hidden comments | Fewer files. Pollutes stock body semantics and risks Notion-visible noise.                                                                       | Avoid.                                                       |
| Directory bundle                 | Scales well for large pages/files. Too heavy for simple authoring.                                                                               | Use internally or for export/import bundles, not v1 default. |

Long-term choice: `.nmd` with self-contained frontmatter by default, plus optional sidecar pointer when the strict storage budget or volatility rules require it.

## Conflict Options

| Option                             | Tradeoffs                                                                                                                         | Recommendation                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Last-writer-wins `replace_content` | Simple, but silently overwrites remote work.                                                                                      | Only for explicit `--force`.               |
| Guarded replace                    | Safe when remote base is unchanged. Blocks independent concurrent edits.                                                          | V1 default.                                |
| Three-way merge                    | Preserves independent edits and can use Roughdraft for unresolved decisions. Requires canonicalization and sidecar participation. | Long-term default after v1.                |
| Targeted `update_content`          | Useful exact-match transport for small unique hunks. Not atomic enough to be the merge engine; response verification is required. | Optimization, not the main conflict model. |

Long-term choice: guarded push first, then canonical three-way merge. Use `update_content` only for verified small hunks.

## Review And Comments Options

| Option                                             | Tradeoffs                                                                               | Recommendation           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| Roughdraft local-only                              | Full suggestion semantics, portable in Markdown. Not visible as native Notion comments. | Best default.            |
| Export Roughdraft comments to Notion page comments | Makes feedback visible in Notion. Loses exact text-span anchoring.                      | Useful explicit bridge.  |
| Export Roughdraft suggestions as Notion comments   | Preserves discussion, not pending edit semantics.                                       | Optional, clearly lossy. |
| Push unresolved Roughdraft markers as body text    | Notion escapes them as visible literal text.                                            | Avoid by default.        |

Long-term choice: Roughdraft is the local review source of truth. Notion comments are a separate projection, keyed by sidecar metadata.

## Unsupported Blocks And Files

| Concern            | Finding                                                                                      | Long-term choice                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Unsupported blocks | Bookmark/embed pulled as `<unknown>` and require block API retrieval for lossless snapshots. | Preserve compact units in frontmatter; sidecar raw snapshots.          |
| Page references    | Markdown write failed for page-reference syntax; `link_to_page` pulled as unknown.           | Use block API fallback and manifest.                                   |
| Link previews      | Not creatable through append-child API in the tested path.                                   | Preserve if encountered; do not promise creation.                      |
| File uploads       | Single-part upload works; Notion URLs are volatile/expiring.                                 | Keep compact lifecycle units in frontmatter; file bytes/cache outside. |
| Media colors       | URLs/captions round-trip, colors were dropped.                                               | Treat as partial fidelity until proven otherwise.                      |

Long-term choice: self-contained frontmatter first; per-page JSON sidecar and optional `.notion-md/` content-addressed cache when state is too large or contains volatile retrieval data.

## Data Sources And Properties

| Option                            | Tradeoffs                                                               | Recommendation                                            |
| --------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Body-only row sync                | Simple but loses typed properties.                                      | Not acceptable for database rows.                         |
| Editable typed frontmatter        | Human-readable and schema-aware. Needs property-id/name reconciliation. | Best default.                                             |
| Generated TypeScript schemas only | Strong typing, but less direct for hand-edited files.                   | Reuse for validation and codegen, not as the only format. |
| Sidecar-only properties           | Keeps body clean, but hides important row state.                        | Use only for bulky/read-only schema snapshots.            |

Long-term choice: typed editable frontmatter for writable properties, generated schemas from `@overeng/notion-cli` for validation, sidecar for schema snapshots and read-only derived state.

## Webhooks

Webhooks are useful notifications, not sync history.

Use them to trigger `status` or `pull` refreshes. Do not use them as merge evidence. Every push must still re-fetch the current remote body/properties and compare against the stored base.

## V1 Cut

The best first production slice:

- `pull <page> --out doc.nmd`
- `status doc.nmd`
- `push doc.nmd --dry-run`
- `push doc.nmd`
- `.nmd` frontmatter with page id, body hash, timestamps, property state, and a strict `storage` tagged union
- stock enhanced Markdown body only
- guarded replace push with `allow_deleting_content: false`
- fail on unresolved unknown blocks unless sidecar preservation is implemented
- local Roughdraft conflicts, not native Notion suggestions
- comment sync as explicit `comments pull|push`, not implicit body sync

## Later Cuts

- canonical three-way merge with Roughdraft conflict output
- targeted `update_content` optimization for verified hunks
- block API fallback for page references and unsupported blocks
- single-part file upload lifecycle
- data-source row property sync
- Notion comment bridge with sidecar `comment_id` / `discussion_id`
- automatic sidecar escalation from large/volatile frontmatter storage
- content-addressed `.notion-md/` cache
- webhook-triggered status refresh
