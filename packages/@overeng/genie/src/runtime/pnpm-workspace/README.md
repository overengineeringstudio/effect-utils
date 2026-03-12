# pnpm-workspace

Generate `pnpm-workspace.yaml` files.

## Mental Model

- `pnpmWorkspaceYaml.package(...)` projects a package-local
  `pnpm-workspace.yaml` from package metadata
- `pnpmWorkspaceYaml.root(...)` projects a root aggregate
  `pnpm-workspace.yaml` from multiple package outputs
- `pnpmWorkspaceYaml.manual(...)` exists only for genuine
  non-package workspaces that cannot be modeled from package seeds
- package metadata must already contain static import-time workspace facts;
  runtime `ctx` is only used during projection
- package-local `pnpm-workspace.yaml` may remain as projection metadata, but
  package-local `pnpm-lock.yaml` is not part of the intended model

Normal authoring should use only:

- `pnpmWorkspaceYaml.manual(...)` for explicit non-package manifests only
- `pnpmWorkspaceYaml.package(...)`
- `pnpmWorkspaceYaml.root(...)`

Keep lower-level workspace graph traversal and path derivation internal. The
public story is package-level projection and root aggregate projection.

## Usage

### Package-level projection

```ts
import pkg from './package.json.genie.ts'
import examplePkg from './examples/basic/package.json.genie.ts'
import { pnpmWorkspaceYaml } from '../../../genie/internal.ts'

export default pnpmWorkspaceYaml.package({
  pkg,
  packages: [examplePkg],
})
```

### Root aggregate projection

```ts
import appPkg from './packages/app/package.json.genie.ts'
import sharedPkg from './packages/shared/package.json.genie.ts'
import { pnpmWorkspaceYaml } from './genie/internal.ts'

export default pnpmWorkspaceYaml.root({
  packages: [appPkg, sharedPkg],
  dedupePeerDependents: true,
})
```

## Why wrappers exist

The wrappers are the public projection API because package authoring should
project from package metadata, not maintain workspace member lists manually.
Low-level workspace graph helpers are intentionally internal.

Use real package generator outputs as workspace seeds. If a repo member should
participate in the workspace, give it a package generator and include that
output instead of threading extra member paths through the public API.

Use `pnpmWorkspaceYaml.manual(...)` only when the workspace intentionally
includes members that are not represented by package generator outputs.
