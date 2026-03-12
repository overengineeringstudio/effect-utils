# pnpm-workspace

Generate `pnpm-workspace.yaml` files.

## Mental Model

- `pnpmWorkspaceYamlFromPackage(...)` projects a package-local
  `pnpm-workspace.yaml` from package metadata
- `pnpmWorkspaceYamlFromPackages(...)` projects a root aggregate
  `pnpm-workspace.yaml` from multiple package outputs
- package metadata must already contain static import-time workspace facts;
  runtime `ctx` is only used during projection

`pnpmWorkspaceYaml(...)` is the low-level emitted-data constructor used by those
projection helpers. Treat it as internal/low-level. Normal authoring should use
only:

- `pnpmWorkspaceYamlFromPackage(...)`
- `pnpmWorkspaceYamlFromPackages(...)`

Keep lower-level workspace graph traversal and path derivation internal. The
public story is package-level projection and root aggregate projection.

## Usage

### Package-level projection

```ts
import pkg from './package.json.genie.ts'
import { pnpmWorkspaceYamlFromPackage } from '../../../genie/internal.ts'

export default pnpmWorkspaceYamlFromPackage({
  pkg,
})
```

### Root aggregate projection

```ts
import appPkg from './packages/app/package.json.genie.ts'
import sharedPkg from './packages/shared/package.json.genie.ts'
import { pnpmWorkspaceYamlFromPackages } from './genie/internal.ts'

export default pnpmWorkspaceYamlFromPackages({
  dir: import.meta.dirname,
  packages: [appPkg, sharedPkg],
  dedupePeerDependents: true,
})
```

## Why wrappers exist

The wrappers are the public projection API because package authoring should
project from package metadata, not maintain workspace member lists manually.
Low-level workspace graph helpers are intentionally internal.
