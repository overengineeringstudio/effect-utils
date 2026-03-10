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
