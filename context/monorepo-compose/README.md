# Monorepo Composition with pnpm-compose

Pattern for composing multiple pnpm monorepos via git submodules with unified dependency management.

## Problem

When developing across repos (e.g., app + library submodules), you want local submodule changes immediately available without publishing. pnpm workspaces don't natively support this - `pnpm install` fetches submodule packages from npm instead of using local source.

## Solution

Three components work together:

| Component        | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| **pnpm-compose** | Symlink dance to use local submodule packages instead of npm versions            |
| **genie**        | TypeScript-based config generation (package.json, pnpm-workspace.yaml, tsconfig) |
| **devenv/Nix**   | Distributes tools (pnpm-compose, genie binaries) before `pnpm install` runs      |

## Quick Start

### 1. Add effect-utils submodule

```bash
git submodule add git@github.com:overengineeringstudio/effect-utils.git submodules/effect-utils
git submodule update --init --recursive
```

### 2. Create devenv.yaml

```yaml
inputs:
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
  genie:
    url: github:overengineeringstudio/effect-utils?dir=packages/@overeng/genie
  pnpm-compose:
    url: github:overengineeringstudio/effect-utils?dir=packages/@overeng/pnpm-compose
```

### 3. Create devenv.nix

```nix
{ pkgs, inputs, ... }:
{
  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    inputs.genie.packages.${pkgs.system}.default
    inputs.pnpm-compose.packages.${pkgs.system}.default
  ];

  # pnpm guard overlay - prevents accidental pnpm install in submodules
  overlays = [
    inputs.pnpm-compose.overlays.pnpmGuard
  ];

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
  '';
}
```

### 4. Create .envrc

```bash
export WORKSPACE_ROOT=$(pwd)
use devenv
```

### 5. Create .gitignore entries

```gitignore
# devenv
.devenv/
devenv.lock
```

### 6. Create repo config

```ts
// genie/repo.ts
import { createPackageJson } from '@overeng/genie/lib'
import { catalog as effectUtilsCatalog } from './submodules/effect-utils/genie/repo.ts'

// Compose catalog - effect-utils base + project-specific
export const catalog = {
  ...effectUtilsCatalog,
  'my-special-package': '1.0.0',
} as const

// Type-safe package.json builder
export const pkg = createPackageJson({
  catalog,
  workspacePackages: ['@myorg/*', '@overeng/*'],
})
```

### 7. Create workspace config generator

```ts
// pnpm-workspace.yaml.genie.ts
import { pnpmWorkspace } from '@overeng/genie/lib'
import { catalog } from './genie/repo.ts'

export default pnpmWorkspace({
  packages: [
    'apps/*',
    'packages/*',
    'submodules/effect-utils/packages/*',
  ],
  catalog,
})
```

### 8. Create a package.json.genie.ts

```ts
// packages/@myorg/utils/package.json.genie.ts
import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@myorg/utils',
  version: '1.0.0',
  type: 'module',
  exports: { '.': './src/mod.ts' },
  dependencies: ['effect', '@effect/platform'],
  devDependencies: ['typescript', 'vitest'],
})
// Typos like 'effct' cause compile-time errors!
```

### 9. Initialize

```bash
direnv allow
genie                  # Generate config files
pnpm-compose install   # Install deps + symlink dance
```

### 10. Verify setup

```bash
# Check tools are available
genie --version
pnpm-compose --version

# Verify symlinks point to submodule source (not .pnpm store)
ls -la node_modules/@overeng/
# Should show: utils -> ../../submodules/effect-utils/packages/@overeng/utils

# Test a submodule package change is immediately visible
echo "// test" >> submodules/effect-utils/packages/@overeng/utils/src/mod.ts
# Your app should see this change without reinstalling
```

## Architecture

### Submodule dependency tree (example)

```
my-app                              <- root repo
├── effect-utils                    <- direct dependency
├── lib-a                           <- submodule (has effect-utils)
│   └── effect-utils                <- lib-a's dependency (same repo)
└── lib-b                           <- submodule (has effect-utils)
    └── effect-utils                <- lib-b's dependency (same repo)
```

Note: pnpm-compose symlinks all effect-utils packages to the effect-utils submodule.

### Directory structure

```
my-app/                           <- Parent repo
├── genie/repo.ts                 <- Catalog source (composes from children)
├── pnpm-workspace.yaml.genie.ts  <- Generates workspace config
├── tsconfig.base.json.genie.ts   <- Uses baseTsconfigCompilerOptions
├── pnpm-compose.config.ts        <- Optional: exclude submodules
├── devenv.yaml                   <- devenv inputs
├── devenv.nix                    <- devenv config
├── node_modules/
│   ├── @overeng/utils            -> submodules/effect-utils/packages/@overeng/utils (symlink!)
│   └── react/                    <- Regular npm dependency
└── submodules/
    └── effect-utils/             <- Git submodule (foundation)
        ├── genie/repo.ts         <- Base catalog + TS config utilities
        └── packages/@overeng/*/
```

### Multi-level composition

For complex setups with nested submodules:

```
my-app/                           <- Top-level app
├── genie/repo.ts                 <- Composes ALL catalogs
└── submodules/
    ├── effect-utils/             <- Foundation (catalog, TS config, genie tools)
    │   └── genie/repo.ts
    ├── lib-a/                    <- Extends effect-utils
    │   └── genie/repo.ts         <- imports from ../../effect-utils/genie/repo.ts
    └── lib-b/                    <- Extends effect-utils
        └── genie/repo.ts         <- imports from ../../effect-utils/genie/repo.ts
```

### Reuse hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                      effect-utils (foundation)                   │
│  • Core catalog (Effect, React, TypeScript, Vite, testing)      │
│  • baseTsconfigCompilerOptions (strict settings + Effect LSP)   │
│  • packageTsconfigCompilerOptions, domLib, reactJsx             │
│  • genie package (createPackageJson, tsconfigJSON utilities)    │
└─────────────────────────────────────────────────────────────────┘
                              ▲
          ┌───────────────────┼───────────────────┐
          │                   │                   │
┌─────────┴─────────┐ ┌───────┴───────┐ ┌────────┴────────┐
│      lib-a        │ │     lib-b     │ │     my-app      │
│  + OTel exporters │ │  + Astro/docs │ │  + Storybook    │
│  + dev tools      │ │  + Cloudflare │ │  + Electron     │
└───────────────────┘ └───────────────┘ └─────────────────┘
```

### Catalog composition flow

```
effect-utils/genie/repo.ts    ->  child/genie/repo.ts    ->  pnpm-workspace.yaml
     (base catalog)                (composed catalog)          (generated)
         │                              │
         │                              └── pkg() builder
         └─────────────────────────────────── tsconfig utilities
```

### Symlink dance

1. `pnpm install` creates symlinks to `.pnpm/` store
2. pnpm-compose replaces them with symlinks to submodule source
3. `pnpm install --lockfile-only` updates lockfile, preserves our symlinks

## Nix Setup

### devenv (recommended)

Use GitHub URLs for simplicity - devenv fetches packages directly:

```yaml
# devenv.yaml
inputs:
  genie:
    url: github:overengineeringstudio/effect-utils?dir=packages/@overeng/genie
  pnpm-compose:
    url: github:overengineeringstudio/effect-utils?dir=packages/@overeng/pnpm-compose
```

### Pure Nix flakes (local development)

For local submodule development, pure flakes with `inputs.self.submodules = true` lets Nix see submodule files:

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    genie = {
      url = "path:./submodules/effect-utils/packages/@overeng/genie";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
    pnpm-compose = {
      url = "path:./submodules/effect-utils/packages/@overeng/pnpm-compose";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  # Required for Nix to see files inside git submodules
  inputs.self.submodules = true;

  outputs = { self, nixpkgs, flake-utils, genie, pnpm-compose, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ pnpm-compose.overlays.pnpmGuard ];
        };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.pnpm
            pkgs.nodejs_24
            pkgs.bun
            genie.packages.${system}.default
            pnpm-compose.packages.${system}.default
          ];

          shellHook = ''
            export WORKSPACE_ROOT="$PWD"
            export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
          '';
        };
      });
}
```

With `.envrc`:

```bash
export WORKSPACE_ROOT=$(pwd)
use flake
```

### pnpm guard overlay

The overlay wraps `pnpm` to block install commands inside submodules:

```
┌─────────────────────────────────────────────────────────────┐
│  ERROR: Cannot run 'pnpm install' inside a submodule        │
├─────────────────────────────────────────────────────────────┤
│  You're in a pnpm-compose managed repo.                     │
│  Running pnpm install here would corrupt the workspace.     │
│                                                             │
│  Instead, run from the parent repo:                         │
│    cd /path/to/parent                                       │
│    pnpm-compose install                                     │
└─────────────────────────────────────────────────────────────┘
```

## Reuse Patterns

The key principle: **import from parent repos, don't duplicate**. effect-utils serves as the foundation that child repos extend.

### What effect-utils provides

| From `genie/repo.ts` | Purpose |
|---------------------|---------|
| `catalog` | Dependency versions (Effect, React, TypeScript, etc.) |
| `baseTsconfigCompilerOptions` | Strict TS settings + Effect LSP plugin |
| `packageTsconfigCompilerOptions` | Composite mode for package builds |
| `domLib` | DOM lib types for browser code |
| `reactJsx` | React JSX transform settings |

| From `@overeng/genie/lib` | Purpose |
|--------------------------|---------|
| `createPackageJson` | Type-safe package.json builder |
| `tsconfigJSON` | tsconfig.json generator |
| `pnpmWorkspace` | pnpm-workspace.yaml generator |

### Child repo setup

```ts
// child-repo/genie/repo.ts

// Genie utilities from the genie package
import { createPackageJson } from '@overeng/genie/lib'

// Repo config from effect-utils
import {
  catalog as effectUtilsCatalog,
  baseTsconfigCompilerOptions,
} from '../../effect-utils/genie/repo.ts'

// Re-export for this repo's packages
export { baseTsconfigCompilerOptions }

// Only define packages NOT in effect-utils
const childOnlyCatalog = {
  '@special/package': '1.0.0',
} as const

// Compose catalogs
export const catalog = {
  ...effectUtilsCatalog,
  ...childOnlyCatalog,
} as const

// Type-safe builder for this repo
export const pkg = createPackageJson({
  catalog,
  workspacePackages: ['@child/*', '@overeng/*'],
})
```

### Deciding where packages belong

| Put in effect-utils | Put in child-only |
|--------------------|-------------------|
| Used across multiple repos | Repo-specific tooling |
| Core Effect ecosystem | Domain-specific packages |
| Common dev tools (TS, Vite) | Experimental/unstable |

### TypeScript config reuse

```ts
// tsconfig.base.json.genie.ts
import { tsconfigJSON } from '@overeng/genie/lib'
import { baseTsconfigCompilerOptions } from './submodules/effect-utils/genie/repo.ts'

export default tsconfigJSON({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    // Project-specific overrides
  },
})
```

```ts
// packages/@org/my-pkg/tsconfig.json.genie.ts
import { tsconfigJSON } from '@overeng/genie/lib'
import { packageTsconfigCompilerOptions, domLib, reactJsx } from '../../../genie/repo.ts'

export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    ...packageTsconfigCompilerOptions,
    ...domLib,      // If browser code
    ...reactJsx,    // If React code
  },
  include: ['src'],
})
```

## pnpm-compose Usage

### Commands

```bash
pnpm-compose install         # Full install with symlink dance
pnpm-compose install --clean # Force clean install
pnpm-compose check           # Validate catalog alignment
pnpm-compose list            # Show composed repos
```

### Auto-detection

pnpm-compose auto-detects composed repos from `.gitmodules`. No config needed for most setups.

### Exclusions

Create `pnpm-compose.config.ts` only to exclude submodules:

```ts
export default {
  exclude: [
    'submodules/docs',        // Reference-only, not a pnpm workspace
    'submodules/third-party', // External code, don't compose
  ],
}
```

## Common Workflows

### Adding a dependency

1. Add to `genie/repo.ts` catalog
2. Add to package's `package.json.genie.ts`
3. Run `genie && pnpm-compose install`

### Updating a submodule

```bash
cd submodules/effect-utils
git pull origin main
cd ../..
pnpm-compose check      # Verify catalog still aligns
pnpm-compose install    # Re-sync symlinks if needed
```

### Checking catalog alignment

```bash
pnpm-compose check
# ✓ All catalogs are aligned

# Or if mismatched:
# ✗ Catalog mismatch for 'effect':
#   main: 3.19.14
#   effect-utils: 3.19.13
```

## Troubleshooting

### "Cannot find package X"

Symlinks are stale:

```bash
pnpm-compose install --clean
```

### Catalog mismatch errors

Update the parent's `genie/repo.ts` to match child versions, or update the child.

### Corrupted workspace (node_modules in submodule)

pnpm-compose auto-detects and cleans this on install. If issues persist:

```bash
rm -rf submodules/*/node_modules
pnpm-compose install --clean
```

### Nix can't find submodule files

When using pure flakes with local `path:` URLs, ensure `inputs.self.submodules = true` is in your flake.nix.

## References

- [pnpm-compose README](../../packages/@overeng/pnpm-compose/README.md) - Full CLI docs
- [genie README](../../packages/@overeng/genie/README.md) - Config generator docs
- [devenv inputs docs](https://devenv.sh/inputs/) - devenv input configuration
