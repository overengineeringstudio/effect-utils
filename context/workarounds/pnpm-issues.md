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

## Custom Nix Fetcher for Workspace Dependencies

We use a custom pnpm deps fetcher in `mk-pnpm-cli.nix` instead of nixpkgs' standard
`fetchPnpmDeps`. This was necessary to solve two issues with workspace member dependencies.

### Problem 1: Missing Workspace Member Dependencies

nixpkgs' `fetchPnpmDeps` only fetches dependencies that are visible in the source it
receives. When a package depends on workspace members (e.g., `@overeng/tui-react`), those
members have their own dependencies (e.g., `@vitejs/plugin-react`) that need to be fetched.

However, `fetchPnpmDeps` uses a filtered source that only includes the main package
directory. It doesn't see the workspace members' `package.json` files, so it doesn't
know to fetch their dependencies.

**Symptom:** Hash mismatch errors on Linux where platform-specific packages like
`@esbuild/linux-x64` aren't fetched because they're only referenced by workspace
members, not the main package.

### Problem 2: EACCES Errors in Read-Only Directories

Even if we include workspace member directories in the source filter, pnpm tries to
create `node_modules` directories inside them during install. In a Nix derivation,
the source is read-only, causing:

```
EACCES: permission denied, mkdir '.../tui-react/node_modules'
```

### Solution: Custom Fixed-Output Derivation

Our custom fetcher (`pnpmDeps` in `mk-pnpm-cli.nix`) solves both issues:

1. **Include workspace member package.json files** in the source filter so pnpm knows
   what dependencies to fetch
2. **Make the source tree writable** with `chmod -R +w .` before running `pnpm install`
3. **Use `pnpm install --force`** instead of `pnpm fetch` to properly resolve all
   workspace dependencies

```nix
pnpmDeps = pkgs.stdenvNoCC.mkDerivation {
  # ...
  installPhase = ''
    # Make source writable (critical for workspace members)
    cd "$NIX_BUILD_TOP/source"
    chmod -R +w .

    # Install downloads all deps including workspace member deps
    pnpm install --frozen-lockfile --ignore-scripts --force

    # Archive the store for use in build phase
    tar -cf - . | zstd -o $out/pnpm-store.tar.zst
  '';

  outputHashMode = "recursive";
  outputHash = pnpmDepsHash;
};
```

### Platform-Independent Hashes via supportedArchitectures

To avoid needing separate hashes for Linux and macOS, we configure pnpm to download
platform-specific binaries for all platforms:

```yaml
# pnpm-workspace.yaml
supportedArchitectures:
  os: [linux, darwin]
  cpu: [x64, arm64]
```

This makes the pnpm store contents identical regardless of build platform, so a single
`pnpmDepsHash` works everywhere.

### Auto-Parsing Workspace Members

The builder automatically parses workspace members from `pnpm-workspace.yaml` at Nix
evaluation time, eliminating the need to manually specify them in `build.nix`:

```nix
# Before: manual list that could drift from pnpm-workspace.yaml
workspaceMembers = ["packages/@overeng/tui-core", ...];

# After: automatically parsed from pnpm-workspace.yaml
# (no workspaceMembers argument needed)
```

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

### Solution: `injected: true` in dependenciesMeta

The primary solution is to use pnpm's `injected` feature for workspace deps that
contain React. This creates a **hard copy** of the workspace dep instead of a
symlink, ensuring React resolves from the consumer's pnpm store:

```json
{
  "dependencies": {
    "@overeng/tui-react": "workspace:*"
  },
  "dependenciesMeta": {
    "@overeng/tui-react": {
      "injected": true
    }
  }
}
```

Combined with `publicHoistPattern` in `pnpm-workspace.yaml`, this ensures all
React imports resolve to the same instance:

```yaml
publicHoistPattern: [react, react-dom, react-reconciler]
```

### Cache Invalidation for Injected Deps

Injected copies become **stale** when the source package changes. The pnpm task
module (`pnpm.nix`) auto-detects injected deps by parsing each package's
`dependenciesMeta` at Nix evaluation time. It includes source file content hashes
in the cache key, triggering `pnpm install` when the injected dep's source changes.

No manual configuration needed - just add `"injected": true` to `dependenciesMeta`
and cache invalidation works automatically.

### Other Workarounds (not currently used)

- Centralize React devDependencies in a shared tooling package
- Add a lint/check rule to prevent direct 'react' imports in CLI packages

## Issue: Broken Symlinks in CI Causing oxfmt Crashes

In CI (GitHub Actions), `pnpm install` can occasionally produce broken symlinks inside
nested `node_modules/` directories. When `oxfmt --check packages` traverses the directory
tree, it crashes on these broken symlinks before it can apply its default `node_modules`
skip logic:

```
File not found: packages/@overeng/effect-rpc-tanstack/examples/basic/node_modules/@overeng/utils/node_modules/effect/src/internal/trie.ts
```

### Observations

- **Not reproducible locally or on dev3** - only seen in CI environments
- **Transient** - re-running the failed CI job typically succeeds
- **oxfmt skips `node_modules/` by default** (opt-in via `--with-node-modules`), but the
  crash occurs during filesystem traversal before the skip logic applies
- **oxlint is unaffected** - it handles broken symlinks gracefully
- **`lintPaths` configuration is fine** - `[ "packages" "scripts" "context" ]` is correct;
  the issue is in oxfmt's symlink handling, not the paths

### Workaround

Re-run the failed CI job. If it recurs frequently, consider:
- Filing an upstream oxfmt bug for broken symlink handling
- Wrapping the oxfmt invocation with `find ... -prune` to avoid `node_modules/` at the
  filesystem level instead of relying on oxfmt's internal skip
