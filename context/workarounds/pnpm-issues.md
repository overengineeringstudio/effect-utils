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

> **Status: SOLVED** - Use TypeScript `paths` mapping

Add to `tsconfig.json`:
```json
{
  "compilerOptions": {
    "paths": {
      "react": ["./node_modules/@types/react"]
    }
  }
}
```

## Future: Switch to Bun

We're using pnpm temporarily due to bun bugs. Once fixed, we plan to switch back:

- [#13223 - file: deps extremely slow](https://github.com/oven-sh/bun/issues/13223)
- [#22846 - install hangs in monorepo](https://github.com/oven-sh/bun/issues/22846)
