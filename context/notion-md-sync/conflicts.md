# Notion Markdown Sync Conflict Handling

Status: WIP research note based on real E2E experiments against temporary child pages, archived after the run.

This document focuses on conflict behavior for a Notion <> Markdown sync tool built on Notion enhanced Markdown plus a local Roughdraft review layer. The key design constraint is that Notion page body Markdown, page metadata, comments, child pages/databases, and local review state are separate sync surfaces. Treating them as one last-writer-wins document is easy, but it loses data silently.

## Experiment Summary

The experiments used the official `ntn` CLI with `NOTION_API_TOKEN` and the current Notion API version exposed by the CLI docs. Raw artifacts are under `tmp/notion-md-conflicts/`.

Temporary pages were created under the target parent page and then archived. The archive verification reported `in_trash: true` for all created pages.

Covered behavior:

- `replace_content` overwrote a simulated remote edit. It is whole-page last-writer-wins.
- Single `update_content` with a stale/missing `old_str` failed with a validation error.
- Single `update_content` with a duplicated `old_str` failed unless `replace_all_matches` was true.
- `replace_all_matches` updated every duplicate occurrence.
- Multi-update behavior is mixed:
  - if one update has a duplicated `old_str`, the request fails and no earlier valid update is applied;
  - if one update has a missing `old_str` and another update matches, the request returned success and applied the matching update while silently skipping the missing update.
- Replacing content that would remove a child page failed unless `allow_deleting_content` was true. The error named the affected child page and recommended preserving it with a `<page>` tag or opting into deletion.
- Notion comments could be created, listed, updated, replied to by `discussion_id`, and deleted.
- Deleting the parent comment did not delete a reply in the same discussion; the reply still appeared in the page comment list.
- Comment Markdown parsed inline bold, italic, code, links, and equations into Notion rich text. It is not a block-level Markdown surface.
- Roughdraft markers sent as Notion page body Markdown were escaped on pull. They came back as visible literal text, not as Notion comments or suggestions.
- A page-level Notion comment can carry a Roughdraft-derived note, but Notion does not provide text-span anchoring or native suggestion semantics through the tested APIs.

## Conflict Surfaces

### Page Body Markdown

The body is the primary Markdown sync surface. It is also the easiest place to corrupt remote work because `replace_content` overwrites the entire body. `update_content` gives useful exact-match guards, but it is string-based and Notion normalizes Markdown.

Policy implications:

- Never push body content by blind `replace_content` if the remote body changed since the last pull.
- Use a canonical pulled body as the base, not the user's raw last pushed input.
- Treat Notion Markdown normalization as part of the source-of-truth format.
- Treat `update_content` as a best-effort patch transport, not a general merge engine.
- Verify every requested `update_content` hunk in the response body after a successful request because missing hunks inside multi-update requests can be skipped without failing the request.

### Child Pages And Databases

Child pages and databases are body-adjacent but not body-owned by default. Notion blocks accidental deletion unless `allow_deleting_content` is set, which is the right default for this tool.

Policy implications:

- Default to `allow_deleting_content: false`.
- Preserve known child pages/databases with enhanced Markdown tags or sidecar ownership records.
- Require explicit user intent before deleting child pages/databases.
- Do not infer that a missing child tag means deletion is intended.

### Comments

Notion comments are separate from `GET /markdown`. They can be synchronized, but they do not belong in the body hash.

Policy implications:

- Model comments as a separate surface with separate cursors/hashes.
- Use comment IDs and `discussion_id` for identity and threading.
- Do not assume deleting a parent comment deletes the whole discussion.
- Round-trip comment bodies through rich text or inline comment Markdown; do not expect headings, lists, tables, fenced code, or blockquotes to become structured comment content.

### Roughdraft Review Layer

Roughdraft Flavored Markdown 0.1 defines inline review annotations in the Markdown body: comments, anchored comments, insertions, deletions, substitutions, metadata, and replies. This is valuable local state, but it is not stock Notion enhanced Markdown.

Notion escaped Roughdraft markers when they were sent as page content. That is better than silent interpretation, but it means unresolved Roughdraft review state should not be pushed as normal body content by default.

Policy implications:

- Treat Roughdraft as local review state, not as Notion body syntax.
- Reject normal body pushes that contain unresolved Roughdraft suggestions unless the user chooses an explicit mode.
- Map Roughdraft comments to Notion comments only when anchor resolution is clear enough to avoid misleading placement.
- Keep Roughdraft suggestions local unless accepted, rejected, or rendered visibly under an explicit export mode.

## Policy Options

### Option 1: Last-Writer-Wins

Use `replace_content` for every push.

Pros:

- Simple implementation.
- Matches a user's mental model for `--force`.
- Produces one API call for body updates.

Cons:

- Silently overwrites remote edits.
- Drops comments/review state unless separately handled.
- Risks child page/database deletion if deletion is explicitly allowed.
- Not acceptable as the default for a bidirectional sync tool.

Use only for explicit `--force`, after showing that remote content changed.

### Option 2: Guarded Whole-Page Replace

Pull stores the remote `last_edited_time` and canonical body hash. Push re-fetches metadata and Markdown. If the remote body hash still equals the stored base hash, send `replace_content`; otherwise stop with a conflict.

Pros:

- Simple and safe for non-concurrent edits.
- Avoids accidental last-writer-wins.
- Keeps local file editing straightforward.

Cons:

- Any remote edit blocks the whole push, even if edits are independent.
- Requires robust canonicalization to avoid false conflicts.
- Does not solve comment or child-page ownership by itself.

This should be the first production default.

### Option 3: Guarded Replace With Three-Way Merge

When remote changed, compute a three-way merge from `base`, `local`, and `remote`. If the merge is clean, push the merged body. If unresolved, write conflicts into the local file using Roughdraft comments/suggestions.

Pros:

- Preserves independent edits from both sides.
- Keeps conflicts inspectable in Markdown.
- Matches the long-term goal of a humane sync tool.

Cons:

- Markdown normalization makes naive line merges noisy.
- Unsupported Notion blocks need sidecar participation.
- Roughdraft conflict markers must not be accidentally pushed back as normal Notion body content.

This is the recommended long-term body conflict strategy.

### Option 4: Targeted `update_content` Patch Pushes

Generate exact `old_str` -> `new_str` hunks from local edits and send `update_content`.

Pros:

- Uses Notion's exact-match validation for stale and ambiguous hunks.
- Can avoid replacing unrelated remote content.
- Useful for small isolated edits.

Cons:

- Exact strings are brittle under Notion normalization.
- Duplicate matches need explicit `replace_all_matches`.
- Multi-update requests are not safe to treat as atomic because missing hunks can be skipped while the request succeeds.
- The response must be checked to confirm intended hunks actually landed.

Use this as an optimization for small, unique, verified hunks, not as the only merge strategy.

## Recommended Approach

Use a staged policy:

1. Pull stores a canonical body hash, remote edit timestamp, unknown block IDs, child page/database references, and separate comment state.
2. Push always re-fetches remote metadata and Markdown.
3. If the remote body hash still matches the stored base hash, use `replace_content` with `allow_deleting_content: false`.
4. If the remote body changed, compute a three-way merge over canonical Markdown.
5. For clean merges, prefer `replace_content` with the merged body while still preserving child references and unknown blocks.
6. For small independent hunks, `update_content` may be used, but only when every `old_str` is unique or explicitly intended as `replace_all_matches`, and only after verifying the returned Markdown contains all intended changes.
7. If a hunk is missing, duplicated, overlaps a remote edit, would delete unknown/child content, or produces unresolved merge output, stop and write a local conflict.
8. Represent unresolved body decisions with Roughdraft review markup locally.
9. Sync Notion comments separately from body Markdown. Import them into a sidecar or Roughdraft layer only when identities and anchors are clear.
10. Require explicit modes for unresolved Roughdraft suggestions on push: `reject`, `apply`, `render`, or `strip`.

Default CLI posture:

- `push`: guarded, non-destructive, refuses unresolved conflicts.
- `push --force`: whole-page replace, still blocks child page/database deletion unless a second explicit delete flag is set.
- `push --apply-suggestions`: applies accepted Roughdraft suggestions before pushing.
- `comments pull|push`: separate command group; never hidden inside body sync unless configured.

## Roughdraft To Notion Comment Mapping

Potential mapping:

| Roughdraft item                                | Notion mapping                          | Fidelity                                                                              |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| Standalone comment                             | Page comment                            | Medium; loses exact body position.                                                    |
| Anchored comment with unique text in one block | Block comment plus quoted anchor text   | Medium; block anchor can be stable, text-span anchor remains advisory.                |
| Reply with `re`                                | Comment reply by `discussion_id`        | Medium if the parent Notion discussion is known.                                      |
| Insertion suggestion                           | Comment describing proposed insertion   | Low; Notion has no native pending insertion state.                                    |
| Deletion suggestion                            | Comment describing proposed deletion    | Low; pending deletion remains local.                                                  |
| Substitution suggestion                        | Comment describing replacement          | Low; pending replacement remains local.                                               |
| Resolved Roughdraft item                       | Deleted comment or updated comment text | Low/medium; Notion comment resolution state was not established by these experiments. |

Recommended bridge:

- Keep Roughdraft IDs as local stable IDs.
- Store Notion `comment_id` and `discussion_id` in sidecar metadata, not in visible body text.
- Include a short quoted anchor in the Notion comment body when exporting an anchored Roughdraft comment.
- Do not export suggestions as native Notion edits. Export them either as comments or require applying/rejecting them first.

## Remaining Risks

- The body merge needs a canonical Markdown representation. Without it, Notion's normalization will create false conflicts.
- `update_content` response verification is mandatory because multi-update missing-hunk behavior is not fail-fast.
- Comment deletion semantics need a deliberate model for replies and orphaned discussions.
- Notion comment APIs expose page/block parentage, but not a durable text-span anchor. Anchors can drift after body edits.
- Roughdraft markers in body Markdown are escaped by Notion, so accidental push of review markup creates visible noise.
- Unsupported blocks and unknown block IDs can make a body hash incomplete. Destructive pushes must be blocked while unknowns remain unresolved.
- Child pages/databases are protected by default, but explicit `allow_deleting_content` can still delete important out-of-band content.
- Permissions can make behavior look like missing content. Permission failures must not be treated as deletions or clean empty state.
