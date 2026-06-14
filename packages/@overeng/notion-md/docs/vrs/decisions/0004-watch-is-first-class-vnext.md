# Watch is first-class v-next behavior

Watch mode is part of the v-next sync contract. The next iteration runs watch
through the same Mirror Sync and Shared Sync dispatch used by one-shot `status`
and `sync`.

## Status

accepted

## Consequences

`--watch` must keep live functionality working as a first-class feature. It must
reuse the same frontmatter authority, semantic-equivalence, non-body safety, and
Shared Sync conflict semantics as one-shot sync. Tests must cover watch behavior
for both mechanisms before the redesign is considered complete.
