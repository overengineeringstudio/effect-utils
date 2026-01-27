# pnpm Workspace Pattern

This document describes the standard pnpm workspace pattern used across all repos.

> **Historical context:** For details on past workarounds (`enableGlobalVirtualStore`, `reactTypesPathWorkaround`, `link:` protocol migration), see [this archived gist](https://gist.github.com/schickling/81f218f306d1d645847c6fdc2c7c86cb).

## Pattern: `workspace:*` with Per-Package Workspaces

All repos use `workspace:*` protocol with per-package `pnpm-workspace.yaml` files.

### Why Per-Package Workspaces?

1. **No monorepo root required** - Works with megarepo pattern where repos are nested
2. **Self-contained packages** - Each package declares its own workspace scope
3. **Cross-repo consumption** - External repos can include packages in their workspace
4. **Parallel installs** - No shared state, ~3x faster than sequential

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

## Future: Switch to Bun

We're using pnpm temporarily due to bun bugs. Once fixed, we plan to switch back:

- [#13223 - file: deps extremely slow](https://github.com/oven-sh/bun/issues/13223)
- [#22846 - install hangs in monorepo](https://github.com/oven-sh/bun/issues/22846)
