# Composition Patterns

## Composition Rules

### Repos are independent

Each repo must work standalone. It cannot import from or know about other repos in the workspace at the git level.

```
✗ BAD: effect-utils importing from my-app
✓ GOOD: effect-utils is completely independent
```

### Dependencies via relative paths

Repos depend on each other via `../` paths:

```json
{
  "dependencies": {
    "@overeng/utils": "../@overeng/utils",
    "shared-lib": "../shared-lib"
  }
}
```

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

## What effect-utils provides

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
      '#genie/*': ['../@overeng/genie/src/runtime/*'],
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

## Common Workflows

### Adding a dependency

1. Add to `genie/repo.ts` catalog (or effect-utils if shared)
2. Add to package's `package.json.genie.ts`
3. Run `genie && bun install`

### Adding a new repo dependency

1. Add entry to your repo's `dotdot.json`
2. Run `dotdot sync` from workspace root
3. Run `dotdot link` to create symlinks
4. Use `../repo-name` in your package.json

### Pinning current state

```bash
dotdot update-revs  # Saves all current HEADs to config files
```

### Restoring to pinned state

```bash
dotdot sync  # Clones missing repos, checks out pinned revisions
```

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

**Tips:**

- Define `ownPeerDepNames` locally with only packages NOT in upstream (delta pattern)
- Compute `allPeerDepNames` by spreading upstream keys + own for devDependencies
- Consumers import package configs and spread `.data.peerDependencies`
- Use `catalog.pick()` for exact versions, `catalog.peers()` for `^version` ranges

**Avoid** these unnecessary workarounds: `preserveSymlinks`, path mappings for Effect, postinstall cleanup scripts, `bunfig.toml` tweaks.

## Troubleshooting

| Problem                      | Solution                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| "Cannot find package X"      | Run `dotdot link` then `bun install`                                                  |
| Repo not cloned              | Run `dotdot sync`                                                                     |
| Wrong revision               | Run `dotdot sync` to checkout pinned revisions                                        |
| Revision conflict            | Run `dotdot tree --conflicts` to see conflicts                                        |
| Symlink missing              | Run `dotdot link`                                                                     |
| Nix can't find files         | Ensure repo is cloned, not just symlinked                                             |
| Nix flake input is a symlink | Use `git+file:../repo` for nix, not `path:../repo`                                    |
| Sub-flake purity boundaries  | See `../bun-cli-build/troubleshooting.md`                                             |
| Effect type incompatibility  | Use dual deps pattern (see above), ensure all packages use same catalog versions      |
| "Type X is not assignable"   | Usually duplicate Effect types - check nested node_modules for multiple Effect copies |
