# runtime/

Library code imported by `.genie.ts` files at runtime.

**No npm dependencies allowed** - this code is dynamically imported by the compiled genie binary.

## Output Convention

Genie factories follow this convention:

- first argument: canonical emitted data
- second argument: optional non-emitted metadata

The returned default export is a `GenieOutput<TData, TMeta>` with:

- `data` for emitted output
- optional `meta` for composition by other generators
- `stringify(ctx)` for rendering

Projection helpers should consume `meta` explicitly instead of re-deriving the
same information from generated files.

## Composition Layer

The canonical `@overeng/genie` export is the thin runtime surface for
artifact-focused builders. Reusable cross-artifact helpers live under
dedicated subpath exports so the import path states the abstraction level.

Use `@overeng/genie/composition` for explicit helpers that consume semantic
metadata from generated artifacts. For example,
`tsconfigReferencesFromPackages(...)` projects TypeScript project references
from package workspace dependency metadata without making `tsconfigJson(...)`
know about `packageJson(...)`.
