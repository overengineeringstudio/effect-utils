# Monorepo Composition with pnpm-compose

Pattern for composing multiple pnpm monorepos via git submodules with unified dependency management.

## Problem

When developing across repos (e.g., app + library submodules), you want local submodule changes immediately available without publishing. pnpm workspaces don't natively support this - `pnpm install` fetches submodule packages from npm instead of using local source.

## Solution

| Component        | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| **pnpm-compose** | Symlink dance to use local submodule packages instead of npm versions            |
| **genie**        | TypeScript-based config generation (package.json, pnpm-workspace.yaml, tsconfig) |
| **devenv/Nix**   | Distributes CLI tools (pnpm-compose, genie) before `pnpm install` runs           |

> **Important:** genie CLI is installed via Nix/devenv, not as an npm dependency. The genie lib types are accessed via Node.js subpath imports (`#genie/*`).

## Core Principles

1. **Children are self-contained**: A child repo (e.g., effect-utils) cannot know about or import from its parents. It must work standalone.

2. **Parents compose from children**: Parent repos import and extend from children, never the reverse. This enables the same child to be used by multiple parents.

3. **Single source of truth**: Dependency versions live in the lowest common ancestor. effect-utils defines versions for Effect ecosystem; parent repos only add packages not in effect-utils.

4. **Imports flow upward**: `my-app` → `lib-a` → `effect-utils` (parent imports from child, never reverse)

## Quick Start

### 1. Add effect-utils submodule

```bash
git submodule add git@github.com:overengineeringstudio/effect-utils.git submodules/effect-utils
git submodule update --init --recursive
```

### 2. Set up Nix/devenv

Create `devenv.yaml`:

```yaml
inputs:
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
  nixpkgsUnstable:
    url: github:NixOS/nixpkgs/nixos-unstable
  effect-utils:
    url: github:overengineeringstudio/effect-utils
```

Create `devenv.nix`:

```nix
{ pkgs, inputs, ... }:
let
  pkgsUnstable = import inputs.nixpkgsUnstable { inherit (pkgs) system; };
  cliPackages = inputs.effect-utils.lib.mkCliPackages {
    inherit pkgs pkgsUnstable;
    src = inputs.effect-utils.outPath;
  };
in
{
  # Apply pnpm guard overlay (prevents `pnpm install` in submodules)
  overlays = [ inputs.effect-utils.overlays.pnpmGuard ];

  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    cliPackages.genie
    cliPackages.pnpm-compose
  ];

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
```

Create `.envrc`:

```bash
export WORKSPACE_ROOT=$(pwd)
use devenv
```

Add to `.gitignore`:

```gitignore
.devenv/
devenv.lock
```

### 3. Create genie config files

Create `genie/repo.ts`:

```ts
import { createPackageJson } from '#genie/mod.ts'
import {
  catalog as effectUtilsCatalog,
  baseTsconfigCompilerOptions,
} from '../submodules/effect-utils/genie/repo.ts'

export { baseTsconfigCompilerOptions }

export const catalog = {
  ...effectUtilsCatalog,
  'my-special-package': '1.0.0', // Only add packages NOT in effect-utils
} as const

export const pkg = createPackageJson({
  packageManager: 'pnpm',
  packageManagerVersion: '10.17.1',
  catalog,
  workspacePackages: ['@myorg/*', '@overeng/*'],
})
```

Create `pnpm-workspace.yaml.genie.ts`:

```ts
import { pnpmWorkspace } from '#genie/mod.ts'
import { catalog } from './genie/repo.ts'

export default pnpmWorkspace({
  packages: ['apps/*', 'packages/*', 'submodules/effect-utils/packages/*'],
  catalog,
})
```

The root `package.json.genie.ts` should set up the import map for `#genie/*`:

```ts
import { pkg } from './genie/repo.ts'

export default pkg.root({
  name: '@myorg/monorepo',
  version: '0.0.0',
  type: 'module',
  private: true,
  imports: {
    '#genie/*': './submodules/effect-utils/packages/@overeng/genie/src/lib/*',
  },
  devDependencies: ['typescript', 'vitest'],
})
```

And `tsconfig.base.json.genie.ts` needs matching `paths` for TypeScript IDE support:

```ts
import { tsconfigJSON } from '#genie/mod.ts'
import { baseTsconfigCompilerOptions } from './genie/repo.ts'

export default tsconfigJSON({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    paths: {
      '#genie/*': ['./submodules/effect-utils/packages/@overeng/genie/src/lib/*'],
    },
  },
})
```

### 4. Create a package

Create `packages/@myorg/utils/package.json.genie.ts`:

```ts
import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@myorg/utils',
  version: '1.0.0',
  type: 'module',
  exports: { '.': './src/mod.ts' },
  dependencies: ['effect', '@effect/platform'], // Typos cause compile errors!
  devDependencies: ['typescript', 'vitest'],
})
```

### 5. Initialize

```bash
direnv allow
genie                  # Generate config files
pnpm-compose install   # Install deps + symlink dance
```

## Commands

```bash
pnpm-compose install         # Full install with symlink dance
pnpm-compose install --clean # Force clean install
pnpm-compose check           # Validate catalog alignment
pnpm-compose list            # Show composed repos
```

pnpm-compose auto-detects composed repos from `.gitmodules`. Create `pnpm-compose.config.ts` only to exclude submodules.

## Further Reading

- [Architecture](./architecture.md) - How composition works, directory structure
- [Patterns](./patterns.md) - Composition best practices, troubleshooting
- [Nix Setup](./nix-setup.md) - Alternative Nix configurations (pure flakes)
- [pnpm-compose README](../../packages/@overeng/pnpm-compose/README.md) - Full CLI docs
- [genie README](../../packages/@overeng/genie/README.md) - Config generator docs
