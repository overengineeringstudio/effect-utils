# Composition Patterns

## Composition Rules

### Children are self-contained

A child repo (like effect-utils) must work standalone. It cannot import from or know about its parents.

```
✗ BAD: effect-utils importing from my-app or leaking information to its parent
✓ GOOD: effect-utils is completely independent
```

### Parents compose from children

Parent repos extend children by importing and spreading their exports:

```ts
// my-app/genie/repo.ts
import { catalog as childCatalog } from './submodules/effect-utils/genie/repo.ts'

export const catalog = {
  ...childCatalog, // Inherit all child packages
  'my-package': '1.0.0', // Add parent-specific packages
} as const
```

### Where packages belong

**In effect-utils (foundation):**

- Effect ecosystem (`effect`, `@effect/*`)
- Build tools (`typescript`, `vite`, `vitest`)
- Common UI (`react`, `tailwindcss`)
- Packages used across multiple repos

**In child repos only:**

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
| `pnpmWorkspace`             | pnpm-workspace.yaml generator  |

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
      '#genie/*': ['./submodules/effect-utils/packages/@overeng/genie/src/runtime/*'],
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
3. Run `genie && pnpm-compose install`

### Updating a submodule

```bash
cd submodules/effect-utils && git pull origin main && cd ../..
pnpm-compose check      # Verify catalog alignment
pnpm-compose install    # Re-sync symlinks
```

## Troubleshooting

| Problem                        | Solution                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| "Cannot find package X"        | `pnpm-compose install --clean`                                     |
| Catalog mismatch               | Update parent's `genie/repo.ts` to match child versions            |
| node_modules in submodule      | `rm -rf submodules/*/node_modules && pnpm-compose install --clean` |
| Nix can't find submodule files | Add `inputs.self.submodules = true` to flake.nix                   |
| Nix flake input is a symlink   | Avoid `path:` inputs that resolve through symlinks; use a real path override in `.envrc` |
