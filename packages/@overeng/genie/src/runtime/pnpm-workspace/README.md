# pnpm-workspace

Generate the repo-root `pnpm-workspace.yaml`.

## Mental Model

- `pnpmWorkspaceYaml.root(...)` projects a root aggregate
  `pnpm-workspace.yaml` from multiple package outputs for an explicit repo view
- requires an explicit `repoName` — projection does not infer the current repo
- `extraMembers` is an exceptional compromise for non-genie-managed workspace
  member paths (e.g. standalone, copyable examples) that cannot be derived from
  package metadata — prefer real package generators over `extraMembers`
- package metadata must already contain static import-time workspace facts;
  runtime `ctx` is only used during projection
- package closures used by Nix/tooling are derived internally from package
  metadata and are not committed workspace manifests

## Usage

### Root aggregate projection

```ts
import appPkg from './packages/app/package.json.genie.ts'
import sharedPkg from './packages/shared/package.json.genie.ts'
import { pnpmWorkspaceYaml } from './genie/internal.ts'

export default pnpmWorkspaceYaml.root({
  packages: [appPkg, sharedPkg],
  repoName: 'my-repo',
  dedupePeerDependents: true,
})
```

### With non-genie-managed workspace members (exceptional)

```ts
export default pnpmWorkspaceYaml.root({
  packages: [appPkg, sharedPkg],
  repoName: 'my-repo',
  extraMembers: ['examples/*'],
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

For rare cases where workspace members are intentionally not genie-managed
(e.g. standalone, copyable examples), `extraMembers` is an exceptional
compromise. Prefer creating real package generators over using `extraMembers`.
