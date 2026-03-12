# package-json

Generate `package.json` files from typed data.

## Mental Model

- first argument: canonical emitted `package.json` data
- second argument: optional non-emitted metadata
- metadata must be static import-time data, not runtime `ctx`

The generated file only contains the first argument. The second argument is for
composition by other Genie files.

For normal package authoring, the intended path is:

- `catalog.compose(...)`
- `packageJson(data, composition)`

Treat the composition object as coupled package-authoring state. Avoid manually
assembling emitted dependency maps and workspace metadata from separate sources.
The important safety boundary is package authoring time. After that, the
workspace metadata can be treated as normalized graph metadata for projection.

## Usage

```ts
import utilsPkg from '../utils/package.json.genie.ts'
import { catalog, packageJson } from '../../../genie/internal.ts'

const deps = catalog.compose({
  workspace: {
    repoName: 'my-repo',
    memberPath: 'packages/app',
  },
  dependencies: {
    workspace: [utilsPkg],
    external: catalog.pick('react'),
  },
})

export default packageJson(
  {
    name: '@myorg/app',
    version: '1.0.0',
  },
  deps,
)
```

If local workspace dependency specs (`workspace:`, `file:`, `link:`) are
emitted, the package must also carry workspace metadata. The supported path is
to pass the coupled `deps` composition object as the second argument to
`packageJson(...)`.
Passing raw `workspace` metadata directly is intentionally unsupported for that
case. Manually emitting local workspace deps without coupled composition fails
validation.

## Composition

Importing another package's Genie file gives access to:

- `pkg.data` for emitted `package.json` data
- `pkg.meta` when that file provided metadata

This is useful for:

- workspace dependency recomposition
- aggregate workspace generation
- recomposing inherited peer installs when needed

## Catalog Helpers

Use:

- `catalog.pick(...)` for external dependency versions
- `catalog.compose({ workspace, dependencies, devDependencies, peerDependencies, mode })`
  to derive one coupled package composition object

Use `mode: 'manifest'` for normal package manifest composition.
Use `mode: 'install'` for private/app-style install composition when inherited
peer dependencies from imported workspace packages should also be installed
explicitly from the catalog. `peerDependencies` are the semantic source of
truth for these inherited installs; no extra install metadata is needed.

When `mode: 'install'` is enabled, inherited peer installs come from the
composed workspace packages' `peerDependencies` plus any explicit
`peerDependencies.external` entries. Avoid manually spreading imported
packages' `data.peerDependencies` into emitted dependency buckets.

Pass `dependencies.external` / `devDependencies.external` as the result of
`catalog.pick(...)`, not as catalog keys. Keep package-level composition on the
coupled `composition` object and avoid manually threading emitted dependency
maps and workspace metadata separately.

`catalog.compose(...)` expects imported workspace package modules, not package
names. This avoids a second registry and keeps package-local definitions as the
source of truth.

Pass the coupled result back into `packageJson(...)` as
`packageJson(data, deps)` so emitted dependencies and non-emitted workspace
metadata stay coupled. When using composition, emitted `dependencies` and
`devDependencies` must come from the composition object, not from the first
argument.

Treat this coupled composition path as the only normal authoring API for local
workspace dependency specs. Lower-level workspace metadata shaping is
intentionally unsupported for normal package authoring.

The metadata contains stable composition facts such as logical workspace
identity (`repoName`, `memberPath`) and imported workspace deps. Projection
helpers receive `ctx` later when they need to render relative paths.

For repository aggregates and projections, keep using the dedicated helpers:

- `packageJson.aggregate(...)`
- `packageJson.aggregateFromPackages(...)`
- `pnpmWorkspaceYaml.package(...)`
- `pnpmWorkspaceYaml.root(...)`

Treat aggregate manifests as coordination files, not packages. They only
declare related workspace members and automatically emit `private: true` plus
the required `packageManager`. They do not own dependencies, scripts, exports,
or publish settings.

Do not treat lower-level workspace graph internals as co-equal authoring APIs.
Those helpers are intentionally internal adapter code for the composed-root
projection layer.
