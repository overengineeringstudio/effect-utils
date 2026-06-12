# Single-source pages are authoritative mirrors

Single-source pages (`source: local` and `source: remote`) are authoritative mirrors, not conflict-detecting sync modes. This preserves the no-stored-base invariant: `source: local` may mirror local content over remote drift, `source: remote` may refresh local content from Notion, and users who need concurrent-edit detection opt into `source: shared`.

## Status

accepted

## Consequences

The VRS must not promise single-source refusal of unseen edits. Any warning or preview for single-source drift must be derived from a fresh live comparison only; it must not introduce durable base snapshots or equivalent hidden state.

`sync` does not require confirmation or `--force` for single-source overwrites.
The authority declaration lives in frontmatter, not in invocation-time flags.
`status` is the preview surface; human output must state the overwrite
consequence, while `sync` applies the declared authority directly. `--force`
remains reserved for `source: shared`, where a real base-anchored conflict
exists.

`status` is recommended before `sync` when a user wants an overview, but it is
not required. Every write command also exposes `--dry-run` as an execution-local
preview. Requiring a prior `status` would either be unenforceable or introduce a
durable "last previewed" marker, which would violate Mirror Sync statelessness
and would not compose with watch mode.
