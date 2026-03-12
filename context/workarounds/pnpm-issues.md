# Archived pnpm Workarounds

This file is historical context only.

The current upstream Genie/pnpm model is metadata-driven and should be learned
from:

- `packages/@overeng/genie/src/runtime/package-json/README.md`
- `packages/@overeng/genie/src/runtime/pnpm-workspace/README.md`
- `context/node-modules-install/spec.md`

The old patterns that previously lived here are no longer the intended public
authoring story:

- manually maintained per-package workspace member lists
- direct low-level `pnpmWorkspaceYaml(...)` authoring
- manual coupling of emitted dependency maps and workspace metadata
- handwritten aggregate root member lists as the primary source of truth

If a repo still needs a lower-level or transitional path, treat it as an
adapter and prefer converging it onto:

- `catalog.compose(...)`
- `packageJson(data, composition)`
- `pnpmWorkspaceYaml.package(...)`
- `pnpmWorkspaceYaml.root(...)`
- `packageJson.aggregateFromPackages(...)`
