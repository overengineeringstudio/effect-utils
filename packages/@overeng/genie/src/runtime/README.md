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

## Filesystem inputs and warm generation caches

With `GENIE_INPUT_MANIFEST` set, a successful full generation (all phases,
validation enabled, not a dry run) atomically publishes that file. Its first line
is `genie-inputs-v1` when source closure analysis completes, or
`genie-inputs-incomplete` when it cannot establish the closure. Only `v1` is
cacheable; incomplete/unknown headers must mean a cache miss. Remaining lines
are sorted, deduplicated absolute input paths, terminated by newlines.
Failed, interrupted, partial, and dry runs never
replace an existing manifest. Without the environment variable the CLI behaves
as before.

For generator filesystem reads use `defineRepoContext().readText/readJson`,
or the Node-only `@overeng/genie/node` exports `inputReadFileSync`,
`inputExistsSync`, `inputStatSync`, and `inputReaddirSync`. These retain Node's
overloads and errors and record paths **before** probing, including missing
optional inputs. `recordInput(path)` explicitly declares a dependency read by
another API or a subprocess. Recursive `inputReaddirSync` records returned
paths, including all nested directories; custom walkers must likewise record
each visited directory. Cache consumers hash canonical resolution identity, file
contents, directory entry names/types, and missing markers, not just existing files.

The engine also records generator source and transitive relative/`#`-alias
imports (including helpers and catalogs), bare workspace-package imports after
following symlinks, resolution candidates, package scope/export metadata, and
consulted import-map/megarepo files. Root `megarepo.lock`, `flake.lock`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, and formatter configuration
are inputs too. Literal dynamic imports discoverable by Bun's import scanner
are included; computed import paths must be declared with `recordInput`.
Unresolved, unreadable, or unparseable imports do not make generation fail:
optional imports may legitimately be conditional or caught. They instead mark
the process-shared recording incomplete, so its manifest cannot enable warm
reuse. Missing package export targets can depend on arbitrary resolver metadata;
recording guessed candidate paths alone is not proof of a complete closure.
The real runtime import remains responsible for its own failure semantics.
Installed dependency closures whose real paths remain under `node_modules`
are owned by the package-manager/tool identity, not traversed as generator source.

This is an explicit input contract, **not** transparent process tracing:
arbitrary `node:fs`, `Bun.file`, native libraries, subprocess reads, environment
values, and network responses cannot all be intercepted consistently across
Node/Bun and compiled execution. Custom readers must use these APIs or declare
their file inputs explicitly. Filesystem reads through descriptors need an
explicit path declaration. Retained in-process module caches can retain reads
from earlier runs, so recording conservatively retains previously consulted
paths across successful and failed recording sessions.
