# pnpm-workspace

Generate the repo-root `pnpm-workspace.yaml`.

## Mental Model

- `pnpmWorkspaceYaml.root(...)` projects a root aggregate
  `pnpm-workspace.yaml` from multiple package outputs
- `pnpmWorkspaceYaml.manual(...)` is an escape hatch for rare cases where
  a workspace member is intentionally not genie-managed
- package metadata must already contain static import-time workspace facts;
  runtime `ctx` is only used during projection
- package closures used by Nix/tooling are derived internally from package
  metadata and are not committed workspace manifests

Normal authoring should use `pnpmWorkspaceYaml.root(...)` with package-seed-driven
projection. `pnpmWorkspaceYaml.manual(...)` is available as an escape hatch for
rare edge cases (e.g. workspace members that are intentionally not genie-managed
but must remain in the workspace).

Keep lower-level workspace graph traversal and path derivation internal.

## Usage

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

The wrapper is the public projection API because repo authoring should project
from package metadata, not maintain workspace member lists manually. Low-level
workspace graph helpers are intentionally internal.

Use real package generator outputs as workspace seeds. If a repo member should
participate in the workspace, give it a package generator and include that
output instead of threading extra member paths through the public API.

As an escape hatch, `pnpmWorkspaceYaml.manual(...)` can be used when the
workspace intentionally includes members that are not genie-managed and
cannot be represented by package generator outputs.
