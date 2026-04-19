# Keys and identity

Explains the identity model: what `blockKey` is, how it differs from React's
`key`, the invariants callers must uphold (stability, uniqueness under a
parent, opacity), and what goes wrong when they don't. Should leave the
reader able to assign keys correctly for static trees, list-driven trees,
and partial re-renders.

<!-- TODO: harvest from README.md "blockKey vs key" + "key invariants" sections -->
<!-- TODO: include a ✅/❌ examples table for common mistakes -->
<!-- TODO: cross-link to concepts/reconciler.md for how keys drive diffing -->
