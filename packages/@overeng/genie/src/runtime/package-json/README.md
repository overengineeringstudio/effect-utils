# package-json

Generate `package.json` files from typed data.

## Mental Model

- first argument: canonical emitted `package.json` data
- second argument: optional non-emitted metadata

The generated file only contains the first argument. The second argument is for
composition by other Genie files.

## Usage

```ts
import utilsPkg from '../utils/package.json.genie.ts'
import { catalog, packageJson } from '../../../genie/internal.ts'

const deps = catalog.compose({
  dir: import.meta.dirname,
  workspace: [utilsPkg],
  external: catalog.pick('react'),
})

export default packageJson(
  {
    name: '@myorg/app',
    version: '1.0.0',
    dependencies: deps.dependencies,
  },
  {
    workspace: deps.workspace,
  },
)
```

## Composition

Importing another package's Genie file gives access to:

- `pkg.data` for emitted `package.json` data
- `pkg.meta` when that file provided metadata

This is useful for:

- workspace dependency recomposition
- aggregate workspace generation
- inheriting peer dependency declarations

## Catalog Helpers

Use:

- `catalog.pick(...)` for external dependency versions
- `catalog.compose({ dir, workspace, external })` to derive:
  - emitted `dependencies`
  - non-emitted workspace metadata

Pass `external` as the result of `catalog.pick(...)`, not as catalog keys.

`catalog.compose(...)` expects imported workspace package modules, not package
names. This avoids a second registry and keeps package-local definitions as the
source of truth.
