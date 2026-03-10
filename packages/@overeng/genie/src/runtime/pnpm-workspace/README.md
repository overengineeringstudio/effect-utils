# pnpm-workspace

Generate `pnpm-workspace.yaml` files.

## Mental Model

- `pnpmWorkspaceYaml(...)` expects canonical emitted YAML data
- `pnpmWorkspaceYamlFromPackage(...)` and
  `pnpmWorkspaceYamlFromPackages(...)` are projection helpers that derive that
  emitted data from package metadata

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

The wrapper helpers keep `pnpmWorkspaceYaml(...)` focused on canonical emitted
YAML while still allowing aggregate workspace files to be recomposed from
package-local Genie outputs and their metadata.
