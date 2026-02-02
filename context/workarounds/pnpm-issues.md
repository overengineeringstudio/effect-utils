# pnpm Workspace Pattern

This document describes the standard pnpm workspace pattern used across all repos.

> **Historical context:** For details on past workarounds (`enableGlobalVirtualStore`, `reactTypesPathWorkaround`, `link:` protocol migration), see [this archived gist](https://gist.github.com/schickling/81f218f306d1d645847c6fdc2c7c86cb).

## Pattern: `workspace:*` with Per-Package Workspaces

All repos use `workspace:*` protocol with per-package `pnpm-workspace.yaml` files.

### Why Per-Package Workspaces?

1. **No monorepo root required** - Works with megarepo pattern where repos are nested
2. **Self-contained packages** - Each package declares its own workspace scope
3. **Cross-repo consumption** - External repos can include packages in their workspace
4. **`workspace:*` resolution** - Each package's workspace defines where to find internal deps

### Structure

Each package has its own `pnpm-workspace.yaml`:

```yaml
# packages/@overeng/utils/pnpm-workspace.yaml
packages:
  - .
  - ../*
```

For cross-repo dependencies, include paths to external packages:

```yaml
# apps/my-app/pnpm-workspace.yaml
packages:
  - .
  - ../*
  - ../../repos/effect-utils/packages/@overeng/*
```

### Package.json Dependencies

Use `workspace:*` for all internal dependencies:

```json
{
  "dependencies": {
    "@overeng/utils": "workspace:*",
    "@livestore/common": "workspace:*"
  }
}
```

### Minimal Workspaces for Nix Builds

For packages built with Nix (`mkPnpmCli`), use **minimal workspaces** that only include actual dependencies, not `../*`. This is required because:

1. `fetchPnpmDeps` creates lockfiles with all importers
2. Wide patterns like `../*` include unneeded sibling packages
3. Nix sandbox can't write to sibling directories during install

**Pattern for Nix-built CLIs:**

```typescript
// packages/@overeng/genie/pnpm-workspace.yaml.genie.ts
import { pnpmWorkspace } from '../../../genie/internal.ts'

// Only include actual workspace deps, not ../*
export default pnpmWorkspace('../utils')
```

### Genie Integration

Workspace files are generated via genie using `pnpmWorkspace()`:

```typescript
// pnpm-workspace.yaml.genie.ts
import { pnpmWorkspace } from '../../genie/internal.ts'

export default pnpmWorkspace()
```

After changing workspace config, regenerate lockfile: `cd <package> && pnpm install`

### Sequential Installs (Race Condition Avoidance)

When `pnpm install` runs in a package, it operates on **all** workspace members listed
in `pnpm-workspace.yaml`, not just the current package. This means it installs
dependencies into each workspace member's `node_modules/`.

When multiple packages have overlapping workspace members (e.g., both `genie` and
`notion-cli` include `../utils`, `../tui-react`), running their installs in parallel
causes race conditions - both try to write to the same directories simultaneously,
resulting in ENOENT errors like:

```
ENOENT: no such file or directory, chmod '.../tui-react/node_modules/typescript/bin/tsc'
```

**Solution:** Install tasks run sequentially, each depending on the previous one.

**Alternative:** Dependency-aware parallelism could analyze workspace overlap and only
serialize installs with shared members, restoring parallel execution for non-overlapping
packages. This adds complexity but could provide ~3x speedup for large monorepos

## Future: Switch to Bun

We're using pnpm temporarily due to bun bugs. Once fixed, we plan to switch back:

- [#13223 - file: deps extremely slow](https://github.com/oven-sh/bun/issues/13223)
- [#22846 - install hangs in monorepo](https://github.com/oven-sh/bun/issues/22846)

## Issue: Duplicate React Instances in Per-Package Workspaces

When multiple self-contained packages install their own React devDependencies,
Node resolves different React instances for each package. This triggers
"Invalid hook call" at runtime when a React renderer (e.g. @overeng/tui-react)
and a consumer (e.g. @overeng/genie) each import React from their local
node_modules. A shared pnpm store does not fix this because the store is just a
cache; separate node_modules still produce distinct module instances.

Workarounds to enforce a single React instance during dev:

- Add hoisting rules for React-family packages (e.g. public-hoist-pattern for
  react, react-dom, react-reconciler) in the workspace .npmrc.
- Centralize React devDependencies in a shared tooling package so libraries do
  not install local React copies.
- Add a lint/check rule to prevent direct 'react' imports in CLI packages that
  should use @overeng/tui-react hooks instead.
