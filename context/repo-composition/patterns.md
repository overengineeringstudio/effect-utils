# Composition Patterns

## Composition Rules

### Repos are independent

Each repo must work standalone (with `mr sync`). It cannot import from or know about other repos in the workspace at the git level.

```
BAD:  effect-utils importing from my-app
GOOD: effect-utils is completely independent
```

### Dependencies via relative paths

Repos depend on each other via `../` paths. In a megarepo, repos live under `repos/`, so `repos/my-app` can depend on `../effect-utils`.

```json
{
  "dependencies": {
    "@overeng/utils": "../effect-utils/packages/@overeng/utils",
    "shared-lib": "../shared-lib"
  }
}
```

### Package Structure (Self-Contained)

Each package is self-contained with its own lockfile:

```
packages/@org/my-pkg/
├── package.json          # Own dependencies
├── pnpm-lock.yaml        # Own lockfile (or bun.lock)
├── node_modules/         # Own node_modules
├── tsconfig.json
└── src/
```

**Do not use:**

- Root-level `pnpm-workspace.yaml`
- `workspaces` field in root `package.json`
- Shared/hoisted `node_modules` (except targeted hoisting inside each package workspace for singleton runtimes like React)

**Why:** Tools like pnpm and bun do not support nested monorepos. Since megarepos compose multiple monorepos together, we must use per-package lockfiles to avoid conflicts.

Related issues:

- [pnpm#10302](https://github.com/pnpm/pnpm/issues/10302) - No support for extending child workspaces
- [bun#10640](https://github.com/oven-sh/bun/issues/10640) - Filter fails for nested workspaces
- [bun#11295](https://github.com/oven-sh/bun/issues/11295) - ENOENT errors with nested workspaces

### Where packages belong

**In effect-utils (foundation):**

- Effect ecosystem (`effect`, `@effect/*`)
- Build tools (`typescript`, `vite`, `vitest`)
- Common UI (`react`, `tailwindcss`)
- Packages used across multiple repos

**In your repos only:**

- Domain-specific packages (your business logic)
- Experimental/unstable packages
- Packages only used by that repo

## What effect-utils Provides

| From `genie/repo.ts`             | Purpose                                               |
| -------------------------------- | ----------------------------------------------------- |
| `catalog`                        | Dependency versions (Effect, React, TypeScript, etc.) |
| `baseTsconfigCompilerOptions`    | Strict TS settings + Effect LSP plugin                |
| `packageTsconfigCompilerOptions` | Composite mode for package builds                     |
| `domLib`, `reactJsx`             | Browser/React compiler options                        |

| From genie lib (`#genie/*`) | Purpose                        |
| --------------------------- | ------------------------------ |
| `createPackageJson`         | Type-safe package.json builder |
| `tsconfigJSON`              | tsconfig.json generator        |

> **Note:** genie CLI is installed via Nix/devenv. The genie lib types are accessed via Node.js subpath imports (`#genie/*`), configured in the root `package.json#imports` and `tsconfig.json#paths`.

## TypeScript Config

Base config (repo root):

```ts
// tsconfig.base.json.genie.ts
import { tsconfigJSON } from '#genie/mod.ts'
import { baseTsconfigCompilerOptions } from './genie/repo.ts'

export default tsconfigJSON({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    paths: {
      '#genie/*': ['./effect-utils/packages/@overeng/genie/src/runtime/*'],
    },
  },
})
```

Package config:

```ts
// packages/@org/my-pkg/tsconfig.json.genie.ts
import { tsconfigJSON } from '#genie/mod.ts'
import { packageTsconfigCompilerOptions, domLib, reactJsx } from '../../../genie/repo.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    ...packageTsconfigCompilerOptions,
    lib: domLib, // If browser code
    ...reactJsx, // If React code
  },
  include: ['src'],
})
```

## Typical Workflow

### Adding a dependency

1. Add to `genie/repo.ts` catalog (or effect-utils if shared).
2. Add to the package's `package.json.genie.ts`.
3. Run `genie && bun install` (or `dt genie:run` then `dt pnpm:install`).

### Adding a new repo dependency (megarepo)

1. Add the repo to `megarepo.json`.
2. Run `mr sync` to update symlinks.
3. Use `../repo-name` in your package.json.

## Dual Dependencies Pattern (devDeps + peerDeps)

Library packages that depend on Effect need both standalone type-checking AND consumer compatibility. List Effect packages in **both** `devDependencies` and `peerDependencies`:

```typescript
// packages/@local/shared/package.json.genie.ts
const peerDepNames = ['effect', '@effect/platform', '@effect/rpc'] as const

export default packageJson({
  devDependencies: {
    ...catalog.pick(...peerDepNames, '@types/node', 'typescript'),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
```

**Why:** `devDependencies` enables standalone `tsc --noEmit`. `peerDependencies` signals version requirements to consumers.

**Optional deps:** For optional features, use the same pattern. The deps will be in the lockfile for Nix builds, and consumers install them as needed.

## Delta Pattern for Library Consumers

**Library consumers** (also consumed by others) re-expose peer deps using the **delta pattern** - only define packages not already in the upstream:

```typescript
// packages/@local/pi-remote/package.json.genie.ts (lib that depends on @local/shared)
import sharedPkg from '../shared/package.json.genie.ts'

/** Additional packages not already in @local/shared (delta only) */
const ownPeerDepNames = ['@effect/rpc-http'] as const

/** All peer deps: upstream + own */
const allPeerDepNames = [
  ...Object.keys(sharedPkg.data.peerDependencies ?? {}),
  ...ownPeerDepNames,
] as const

export default packageJson({
  dependencies: {
    '@local/shared': getLocalPackagePath('@local/shared', location),
  },
  devDependencies: {
    ...catalog.pick(...allPeerDepNames, '@types/node', 'typescript'),
  },
  peerDependencies: {
    // Re-expose upstream peer deps + own additional peer deps
    ...sharedPkg.data.peerDependencies,
    ...catalog.peers(...ownPeerDepNames),
  },
})
```

**Why delta pattern?** Avoids duplication of peer deps across packages. When upstream adds a new peer dep, consumers automatically inherit it without manual updates.

## Apps (Leaf Nodes)

**Apps** (leaf nodes, not consumed by others) import upstream configs and spread peer deps into `dependencies`:

```typescript
// apps/my-app/package.json.genie.ts
import sharedPkg from '../@local/shared/package.json.genie.ts'
import piRemotePkg from '../@local/pi-remote/package.json.genie.ts'

export default packageJson({
  dependencies: {
    ...sharedPkg.data.peerDependencies,
    ...piRemotePkg.data.peerDependencies,
    '@local/shared': getLocalPackagePath('@local/shared', location),
  },
  // No peerDependencies needed - this is not a library
})
```

## Workspace Dependencies

Use `workspace:*` protocol for all internal package dependencies:

```json
{
  "dependencies": {
    "@overeng/utils": "workspace:*",
    "@livestore/common": "workspace:*"
  }
}
```

Each package needs its own `pnpm-workspace.yaml` that declares which packages are in scope. See [pnpm-issues.md](../workarounds/pnpm-issues.md) for the full pattern.

**Why `workspace:*`:**

- pnpm resolves to the local package via symlink
- TypeScript correctly resolves types
- Parallel installs work (~3x faster)
- No need for `enableGlobalVirtualStore` or other workarounds

## Explicit Workspace Members Pattern

### Problem

Each package's `pnpm-workspace.yaml` must list ALL workspace members it needs (including transitive deps). With `createWorkspaceDepsResolver`, every transitive dep's `package.json.genie.ts` must be imported into the `deps` array. This is error-prone and breaks silently when upstream adds new internal deps.

### Solution

Each `pnpm-workspace.yaml.genie.ts` calls `pnpmWorkspaceYaml` directly with explicit relative paths. Use path prefix constants to keep paths DRY:

```typescript
// packages/app/pnpm-workspace.yaml.genie.ts
import { pnpmWorkspaceYaml } from '../../repos/effect-utils/genie/external.ts'

const local = '../@local'
const overeng = '../../repos/effect-utils/packages/@overeng'

export default pnpmWorkspaceYaml({
  packages: [
    '.',
    `${local}/shared`,
    `${overeng}/notion-cli`,
    `${overeng}/notion-effect-client`,
    `${overeng}/notion-effect-schema`,
    `${overeng}/utils`,
    `${overeng}/utils-dev`,
  ],
  dedupePeerDependents: true,
})
```

### When to use

Use this pattern instead of `createWorkspaceDepsResolver` when you want explicit control over workspace members without importing `package.json.genie.ts` files. Each workspace template owns its full member list with no indirection.

## CI Deployment with Megarepo Repos

### Problem

CI environments (e.g. Vercel) don't run `mr sync`, so `repos/` directories are missing at build time. Packages that depend on other megarepo members (via relative `../` paths) will fail to install.

### Solution

Use a lightweight install script that reads `megarepo.lock` and shallow-clones the required repos at the pinned commit:

```bash
#!/usr/bin/env bash
set -euo pipefail

COMMIT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('megarepo.lock','utf8')).members['effect-utils'].commit)")
REPO_URL="https://github.com/org/effect-utils"

rm -rf repos/effect-utils
git init repos/effect-utils
git -C repos/effect-utils fetch --depth 1 "$REPO_URL" "$COMMIT"
git -C repos/effect-utils checkout FETCH_HEAD
```

Then reference it from `vercel.json` (each package that deploys to Vercel):

```json
{
  "installCommand": "cd ../.. && bash scripts/vercel-install.sh && cd - && pnpm install --no-frozen-lockfile"
}
```

**Key details:**

- `megarepo.lock` is the source of truth for which commit to clone (same as `mr sync` uses locally)
- `--depth 1` keeps the clone fast and small
- `--no-frozen-lockfile` is needed because the lockfile may drift when transitive workspace deps change
- The script runs from the repo root (`cd ../..`) before returning to the package dir for `pnpm install`

### When to use

Any CI/CD environment that needs to build a package from a megarepo but doesn't have access to `mr sync` or the devenv shell. The pattern generalizes to any CI provider — just call the script before the package manager install step.

## CI Bootstrap with Devenv (GitHub Actions)

### Problem

In CI workflows that use devenv (e.g. GitHub Actions), there is a bootstrap dependency chain:

1. **`genie:run`** (a devenv task) needs to evaluate `.genie.ts` files
2. `.genie.ts` files import from `repos/effect-utils/...` via standard relative paths
3. `repos/` only exists after `mr sync` creates the bare repos + worktree symlinks
4. `mr sync` requires the `mr` CLI, which is normally provided by devenv
5. But devenv tasks (including `genie:run`) run *after* devenv is installed

This creates a chicken-and-egg: devenv provides `mr`, but `mr sync` must run before devenv tasks can work (because genie needs `repos/`).

### Solution

Install `mr` independently before devenv, then sync:

```yaml
# .github/workflows/ci.yml
steps:
  - uses: actions/checkout@v4
  - uses: cachix/install-nix-action@v30
  # 1. Install mr CLI independently (before devenv)
  - run: nix profile install github:org/effect-utils#megarepo
  # 2. Sync repos (creates repos/ symlinks that genie needs)
  - run: mr sync --frozen --verbose
  # 3. Now install devenv (genie:run can find repos/)
  - run: nix profile install github:cachix/devenv/latest
  - run: devenv test  # runs setup tasks including genie:run
```

### Why `mr sync --frozen`

Use `--frozen` (not `--all`) in CI:

- `--frozen` syncs root members to the exact commits in `megarepo.lock` — deterministic and fast
- `--all` additionally recurses into nested megarepos (e.g. effect-utils has its own members), which can fail in CI due to git credential scoping and version mismatches between the standalone `mr` and the devenv-pinned `mr`

The devenv `megarepo:sync` task uses `--all` by default. In CI, root members are already synced by the initial `mr sync --frozen` step, so the recursive nested sync during devenv warmup is redundant and may fail (see [#176](https://github.com/overengineeringstudio/effect-utils/issues/176)).

### Key insight

The **genie CLI binary** is installed via Nix/devenv (`effectUtils.packages.${system}.genie`), but the **genie runtime library** (catalogs, config helpers, TypeScript compiler options) is loaded from `repos/effect-utils/` via standard Node.js module resolution in `.genie.ts` files. There is no import remapping — the `repos/` symlinks must exist on disk.

## Required Root Config Files

Every repo must have these config files at the root:

| File             | Purpose                 | Generated by                      |
| ---------------- | ----------------------- | --------------------------------- |
| `.oxlintrc.json` | Linter configuration    | genie (`.oxlintrc.json.genie.ts`) |
| `.oxfmtrc.json`  | Formatter configuration | genie (`.oxfmtrc.json.genie.ts`)  |

These ensure consistent code style across all repos. The configs are generated via genie to stay in sync with effect-utils defaults.

**Minimal genie files:**

```typescript
// .oxlintrc.json.genie.ts
import { oxlintConfig } from './genie/internal.ts'
export default oxlintConfig()

// .oxfmtrc.json.genie.ts
import { oxfmtConfig } from './genie/internal.ts'
export default oxfmtConfig()
```

See [bun-issues.md](../workarounds/bun-issues.md) for package manager migration plans.

## Tips

- Define `ownPeerDepNames` locally with only packages NOT in upstream (delta pattern)
- Compute `allPeerDepNames` by spreading upstream keys + own for devDependencies
- Consumers import package configs and spread `.data.peerDependencies`
- Use `catalog.pick()` for exact versions, `catalog.peers()` for `^version` ranges

**Avoid** these unnecessary workarounds: `preserveSymlinks`, path mappings for Effect, postinstall cleanup scripts, `bunfig.toml` tweaks.

## Notes

- If Effect types mismatch, check for duplicate versions in nested `node_modules`
