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

## Troubleshooting

| Problem                        | Solution                                                     |
| ------------------------------ | ------------------------------------------------------------ |
| "Cannot find package X"        | Run `dotdot link` then `bun install`                         |
| Repo not cloned                | Run `dotdot sync`                                            |
| Wrong revision                 | Run `dotdot sync` to checkout pinned revisions               |
| Revision conflict              | Run `dotdot tree --conflicts` to see conflicts               |
| Symlink missing                | Run `dotdot link`                                            |
| Nix can't find files           | Ensure repo is cloned, not just symlinked                    |
| Nix flake input is a symlink   | Use `git+file:../repo` for nix, not `path:../repo`           |
| Sub-flake purity boundaries    | See `../bun-cli-build/troubleshooting.md`                   |
