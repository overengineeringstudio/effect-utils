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
  pnpm-compose:
    url: path:./submodules/effect-utils/packages/@overeng/pnpm-compose
    flake: false
  genie:
    url: path:./submodules/effect-utils/packages/@overeng/genie
```

> **Note:** genie uses devenv's flake input mode (no `flake: false`) which requires `.devenv.flake.nix` in the package. pnpm-compose uses `flake: false` since it's consumed via overlay.

### 3. Create devenv.nix

```nix
{ pkgs, inputs, ... }:
{
  # pnpm-compose overlay (used with flake: false)
  overlays = [
    (import "${inputs.pnpm-compose}/nix/overlay.nix")
  ];

  packages = [
    pkgs.pnpm
    pkgs.nodejs_24
    pkgs.bun
    inputs.genie.packages.${pkgs.system}.default
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

### 6. Create catalog source

```ts
// genie/repo.ts
import { catalog as effectUtilsCatalog } from './submodules/effect-utils/genie/repo.ts'

export const catalog = {
  ...effectUtilsCatalog,
  // Project-specific packages
  'my-package': '1.0.0',
} as const

export const catalogRef = 'catalog:' as const
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

### 8. Initialize

```bash
direnv allow
genie                  # Generate config files
pnpm-compose install   # Install deps + symlink dance
```

### 9. Verify setup

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

```
my-app/                           <- Parent repo
├── genie/repo.ts                 <- Catalog source (composes from children)
├── pnpm-workspace.yaml.genie.ts  <- Generates workspace config
├── pnpm-compose.config.ts        <- Optional: exclude submodules
├── devenv.yaml                   <- devenv inputs
├── devenv.nix                    <- devenv config
├── node_modules/
│   ├── @overeng/utils            -> submodules/effect-utils/packages/@overeng/utils (symlink!)
│   └── react/                    <- Regular npm dependency
└── submodules/
    └── effect-utils/             <- Git submodule (real, not symlink)
        ├── genie/repo.ts         <- Child catalog
        └── packages/@overeng/*/
```

**Catalog composition flow:**

```
effect-utils/genie/repo.ts    ->  my-app/genie/repo.ts    ->  pnpm-workspace.yaml
     (child catalog)                (composed catalog)          (generated)
```

**Symlink dance:**

1. `pnpm install` creates symlinks to `.pnpm/` store
2. pnpm-compose replaces them with symlinks to submodule source
3. `pnpm install --lockfile-only` updates lockfile, preserves our symlinks

## Nix/devenv Setup

### Key requirements

1. **Real git submodules** - Symlinks to other directories won't work
2. **pnpm guard overlay** - Prevents accidental `pnpm install` in submodules

### pnpm Guard Overlay

The overlay wraps `pnpm` to block install commands inside submodules:

```nix
overlays = [
  (import "${inputs.pnpm-compose}/nix/overlay.nix")
];
```

When triggered:

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

### GitHub URLs (alternative to submodule paths)

Once effect-utils is published, you can reference packages directly:

```yaml
# devenv.yaml
genie:
  url: github:overengineeringstudio/effect-utils?dir=packages/@overeng/genie
```

### Alternative: Pure Nix Flakes

If you prefer pure flakes over devenv:

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pnpm-compose = {
      url = "path:./submodules/effect-utils/packages/@overeng/pnpm-compose";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
    genie = {
      url = "path:./submodules/effect-utils/packages/@overeng/genie";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  # Critical: enables Nix to see files inside git submodules
  inputs.self.submodules = true;

  outputs = { self, nixpkgs, flake-utils, pnpm-compose, genie, ... }:
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
            pnpm-compose.packages.${system}.default
            genie.packages.${system}.default
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

**Key difference:** Pure flakes require `inputs.self.submodules = true` to see submodule files. devenv handles this automatically.

## Catalog Management

### Defining catalogs

Each repo defines its catalog in `genie/repo.ts`:

```ts
// Child repo (effect-utils)
export const catalog = {
  effect: '3.19.14',
  '@effect/platform': '0.94.1',
  typescript: '5.9.3',
} as const
```

### Composing catalogs

Parent repo imports and extends:

```ts
// Parent repo
import { catalog as effectUtilsCatalog } from './submodules/effect-utils/genie/repo.ts'

export const catalog = {
  ...effectUtilsCatalog,
  // Project-specific additions
  electron: '36.0.0',
  'react-aria-components': '1.14.0',
} as const
```

### Using catalog refs

In package.json.genie.ts files:

```ts
import { catalogRef } from '../genie/repo.ts'

export default packageJSON({
  dependencies: {
    effect: catalogRef,  // -> "catalog:" in generated file
  },
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

### devenv can't find `.devenv.flake.nix`

This error occurs when a flake input (without `flake: false`) doesn't have a `.devenv.flake.nix` file. See [devenv#1137](https://github.com/cachix/devenv/issues/1137).

Solutions:
- Use `flake: false` and build inline (like pnpm-compose does)
- Ensure the package has `.devenv.flake.nix` committed (genie has this)

### Nix can't find submodule files (pure flakes only)

Ensure `inputs.self.submodules = true` is in your flake.nix. This is required for Nix to see files inside git submodules.

## References

- [pnpm-compose README](../../packages/@overeng/pnpm-compose/README.md) - Full CLI docs
- [genie README](../../packages/@overeng/genie/README.md) - Config generator docs
- [devenv inputs docs](https://devenv.sh/inputs/) - devenv input configuration
- Example repos: overtone, livestore
