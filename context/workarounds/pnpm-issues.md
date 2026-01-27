# pnpm Workspace Pattern

This document describes the standard pnpm workspace pattern used across all repos.

> **Historic context:** For details on the `link:` protocol and why we migrated away from it, see [this archived gist](https://gist.github.com/schickling/81f218f306d1d645847c6fdc2c7c86cb).

## Pattern: `workspace:*` with Per-Package Workspaces

All repos use `workspace:*` protocol with per-package `pnpm-workspace.yaml` files.

### Why Per-Package Workspaces?

1. **No monorepo root required** - Works with megarepo pattern where repos are nested
2. **Self-contained packages** - Each package declares its own workspace scope
3. **Cross-repo consumption** - External repos can include packages in their workspace
4. **Consistent resolution** - pnpm creates direct symlinks, deps resolve correctly

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

**Standalone packages (no workspace deps):**

```typescript
// packages/@overeng/utils/pnpm-workspace.yaml.genie.ts
// Utils has no workspace deps - standalone package
export default {
  data: { packages: ['.'] },
  stringify: () => `packages:\n  - .\n`,
}
```

After changing workspace config, regenerate lockfile: `cd <package> && pnpm install`

### Genie Integration

Workspace files are generated via genie using `pnpmWorkspace()`:

```typescript
// pnpm-workspace.yaml.genie.ts
import { pnpmWorkspace } from '../../genie/internal.ts'

export default pnpmWorkspace()
```

With custom patterns:

```typescript
export default pnpmWorkspace(
  '../*',
  '../../repos/effect-utils/packages/@overeng/*'
)
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

## Known Issues

### PNPM-01: Parallel installs with `enableGlobalVirtualStore`

> **Status: KNOWN BUG** - [pnpm#10232](https://github.com/pnpm/pnpm/issues/10232)

When running multiple `pnpm install` in parallel with `enableGlobalVirtualStore`, race conditions can corrupt the store.

**Recovery:**
```bash
rm -rf ~/Library/pnpm/store/v10/links
pnpm install
```

### PNPM-02: TypeScript type inference with `enableGlobalVirtualStore`

> **Status: WORKAROUND IN PLACE** - May be removable with `workspace:*`

When using `enableGlobalVirtualStore`, packages symlink to the global pnpm store, which can break TypeScript's ability to resolve `@types/react`. The workaround adds a `paths` mapping in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "react": ["./node_modules/@types/react"]
    }
  }
}
```

**TODO:** Test if this workaround is still needed after migration to `workspace:*` protocol. With workspace symlinks, dependencies may resolve correctly without `enableGlobalVirtualStore`. To test:
1. Remove `npm_config_enable_global_virtual_store=true` from pnpm install commands
2. Remove `reactTypesPathWorkaround` from tsconfigs
3. Run full TypeScript builds and check for TS2742 errors

## Future: Switch to Bun

We're using pnpm temporarily due to bun bugs. Once fixed, we plan to switch back:

- [#13223 - file: deps extremely slow](https://github.com/oven-sh/bun/issues/13223)
- [#22846 - install hangs in monorepo](https://github.com/oven-sh/bun/issues/22846)
