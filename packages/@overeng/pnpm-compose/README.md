# pnpm-compose

CLI tool for managing multi-repo pnpm workspaces with git submodules. (Relies on Nix.)

## Installation (Nix-only)

pnpm-compose is distributed as a Nix-built binary and is not shipped via `bin` scripts.

```bash
mono nix build --package pnpm-compose
mono nix reload
```

## Problem

When developing across multiple repositories (e.g., an app repo with library submodules), you want:

- Local changes in submodules to be immediately available without publishing
- A single `node_modules/` tree for the entire workspace
- Consistent dependency versions across all repos

pnpm workspaces don't natively support packages from git submodules - it only sees packages defined in the root `pnpm-workspace.yaml`. Running `pnpm install` fetches submodule packages from the npm registry instead of using local source.

## Solution: The Symlink Dance

pnpm-compose solves this by replacing registry-installed packages with symlinks to local submodule packages:

```
node_modules/@acme/core
  Before: → .pnpm/@acme+core@1.0.0/...  (registry version)
  After:  → submodules/acme-lib/packages/core  (local source)
```

This gives you:

- Live updates when editing submodule code
- Correct TypeScript resolution to local `.ts` files
- Single install command that handles everything

## What it does

The `install` command performs the "symlink dance":

1. **Deduplicate submodules** - Automatically replaces duplicate nested git submodules with symlinks to top-level canonical locations
2. **Check catalog alignment** - Validates pnpm catalog versions match across all repos (can be skipped)
3. **Check if symlinks are correct** - If all symlinks point to the right submodule sources, skip install entirely
4. **Incremental fix** - If some symlinks are wrong but node_modules exists, fix only those symlinks + lockfile-only
5. **Full install** - If no node_modules or `--clean` flag, do the full dance: pnpm install → create all symlinks → lockfile-only

The `check` command validates catalog alignment without modifying anything.

The `list` command shows configured repos and their catalog status.

## How it works

Example repo structure:

```
my-app/                              ← Parent repo (workspace root)
├── package.json                     ← Root package.json with all deps
├── pnpm-workspace.yaml              ← Includes submodule paths
├── pnpm-lock.yaml                   ← Single lockfile for everything
├── pnpm-compose.config.ts           ← Defines composed repos
├── node_modules/
│   ├── @acme/db                     → submodules/acme-db/packages/db       (symlink!)
│   ├── @acme/db-react               → submodules/acme-db/packages/react    (symlink!)
│   ├── @foo/toolkit                 → submodules/acme-db/submodules/foo-toolkit/packages/toolkit (symlink!)
│   ├── @bar/utils                   → submodules/bar-utils/src             (symlink!)
│   └── react/                       ← Regular npm dependency
├── apps/
│   └── web/                         ← App in parent repo
├── packages/
│   └── shared/                      ← Package in parent repo
└── submodules/
    ├── acme-db/                     ← Git submodule (standalone monorepo)
    │   ├── package.json
    │   ├── pnpm-workspace.yaml
    │   ├── packages/
    │   │   ├── db/
    │   │   └── react/
    │   └── submodules/
    │       └── foo-toolkit/         ← Nested git submodule
    │           └── packages/toolkit/
    └── bar-utils/                   ← Git submodule (single-package repo)
        └── src/
```

The parent repo's `pnpm-workspace.yaml` includes submodule paths:

```yaml
packages:
  - apps/*
  - packages/*
  - submodules/acme-db/packages/*
  - submodules/acme-db/submodules/foo-toolkit/packages/*
  - submodules/bar-utils
```

## The symlink dance

pnpm-compose targets scenarios where submodule packages are also published to npm. pnpm would normally resolve these from the registry, but we want local source for development.

The dance:

1. `pnpm install` → creates symlinks to `.pnpm/` store
2. Replace symlinks → `node_modules/<pkg>` → submodule source
3. `pnpm install --lockfile-only` → updates lockfile, **preserves our symlinks**

**Key insight**: `pnpm install` restores symlinks, but `--lockfile-only` leaves them untouched.

For workspace packages using `workspace:*`, pnpm natively creates correct symlinks - no dance needed.

See [PNPM_INTERNALS.md](./PNPM_INTERNALS.md) for detailed pnpm behavior analysis.

## Corruption prevention & detection

A common issue: someone (or a coding agent) accidentally runs `pnpm install` in a submodule, creating a rogue `node_modules/` that breaks the workspace.

pnpm-compose provides two layers of protection:

### Prevention: pnpm guard overlay

pnpm-compose exports a Nix overlay that wraps `pnpm` to block `install/i/add` commands when run inside a submodule. The guard auto-detects pnpm-compose repos by looking for marker files (`pnpm-compose.config.ts` or `.gitmodules` + `submodules/` dir) - no configuration needed.

```nix
{
  inputs.pnpm-compose.url = "path:./submodules/effect-utils/packages/@overeng/pnpm-compose";

  outputs = { nixpkgs, pnpm-compose, ... }:
    let
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ pnpm-compose.overlays.pnpmGuard ];
      };
    in {
      devShells.default = pkgs.mkShell {
        buildInputs = [ pkgs.pnpm ];  # Now guarded (zero config!)
      };
    };
}
```

When triggered, shows a clear error:

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

### Using the overlay with devenv

devenv's input system expects `.devenv.flake.nix` files, which standard Nix flakes don't have. To use the pnpm guard overlay in devenv, fetch pnpm-compose as a non-flake source and import the overlay directly:

```yaml
# devenv.yaml
inputs:
  pnpm-compose:
    url: github:overengineeringstudio/effect-utils?dir=packages/@overeng/pnpm-compose
    flake: false
```

```nix
# devenv.nix
{ pkgs, inputs, ... }:
{
  overlays = [
    (import "${inputs.pnpm-compose}/nix/overlay.nix")
  ];

  packages = [ pkgs.pnpm ];  # Now guarded
}
```

**Why `flake: false`?** devenv inputs look for `.devenv.flake.nix` by default. Using `flake: false` bypasses this and fetches the raw source, allowing direct import of `overlay.nix`. Alternative approaches considered:

- **devenv.yaml `overlays:` option** - Cleanest syntax but requires `.devenv.flake.nix` in pnpm-compose
- **flake.nix wrapper** - Full Nix flake compat but requires `nix develop --no-pure-eval` and loses some devenv features
- **Inline overlay** - Works but duplicates code across repos

### Detection: auto-cleanup on install

If corruption does occur, `pnpm-compose install` automatically detects and cleans it:

```
⚠ Detected node_modules in submodules (workspace corruption):
  - submodules/effect-utils/node_modules

This usually happens when `pnpm install` is run inside a submodule.
Auto-cleaning to restore workspace integrity...

  ✓ Removed submodules/effect-utils/node_modules
```

See [PNPM_INTERNALS.md](./PNPM_INTERNALS.md) for details on pnpm behavior.

## Submodule deduplication

When working with nested git submodules, you may encounter the same submodule referenced at multiple levels:

```
my-app/
├── submodules/
│   ├── utils/                    ← Canonical location (top-level)
│   ├── lib-a/
│   │   └── submodules/
│   │       └── utils/            ← Duplicate! (same URL as above)
│   └── lib-b/
│       └── submodules/
│           └── utils/            ← Another duplicate!
```

This creates redundant disk usage and potential confusion about which copy is being used.

**Deduplication runs automatically during `pnpm-compose install`**.

The deduplication process:

1. Scans for duplicate submodules (same git URL across nested repos)
2. Chooses the top-level location as canonical
3. Replaces nested duplicates with symlinks pointing to the canonical location
4. Adds symlink paths to `.git/info/exclude` to prevent git tracking them

**Important**: Deduplication only creates symlinks without modifying git state (`.gitmodules` or git index). This ensures no uncommittable changes are created. Git operations like `git submodule update` respect the symlinks and work correctly.

After deduplication:

```
my-app/
├── submodules/
│   ├── utils/                    ← Real directory (canonical)
│   ├── lib-a/
│   │   └── submodules/
│   │       └── utils/            → ../../utils (symlink)
│   └── lib-b/
│       └── submodules/
│           └── utils/            → ../../utils (symlink)
```

The command is idempotent and safe to run multiple times.

## Trade-offs

- **Version alignment required** - All repos must use identical versions for shared dependencies. pnpm-compose enforces this via catalog checks
- **Parent repo owns root config** - The parent repo's `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` are the source of truth
- **Submodules must be checked out** - Can't install without submodules present

## Limitations

### Workspace glob patterns

pnpm-compose uses a simplified glob parser for `pnpm-workspace.yaml` patterns. Supported patterns:

- `packages/*` - single-level wildcard
- `packages/@*/*` - scoped package wildcard
- `apps/web` - literal paths

**Not supported** (patterns are silently skipped):

- `**` recursive wildcards (`packages/**`)
- Negation patterns (`!packages/internal`)
- Complex patterns (`packages/*/src`)

For unsupported patterns, add explicit paths or restructure to use `*` and `@*` patterns.

## What it doesn't do

- Replace pnpm (works alongside it)
- Handle dependency resolution (pnpm does that)
- Build, test, or lint (use other tools)
- Manage git submodules (use git directly)

## Usage

```bash
# Install: skips if correct, incremental fix if some wrong, full install if no node_modules
pnpm-compose install

# Force full clean install (removes node_modules first)
pnpm-compose install --clean

# Skip catalog alignment check
pnpm-compose install --skip-catalog-check

# Validate catalog alignment without installing
pnpm-compose check

# Show composed repos and catalog status
pnpm-compose list

# Deduplicate git submodules by creating symlinks
pnpm-compose dedupe-submodules
```

### Installation via Nix

Add `effect-utils` as a git submodule, then reference pnpm-compose's flake in your flake:

```bash
git submodule add git@github.com:overengineeringstudio/effect-utils.git submodules/effect-utils
```

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-25.11";
    nixpkgsUnstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pnpm-compose = {
      url = "path:./submodules/effect-utils/packages/@overeng/pnpm-compose";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixpkgsUnstable.follows = "nixpkgsUnstable";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  # Enable submodule support for path references
  inputs.self.submodules = true;

  outputs = { self, nixpkgs, flake-utils, pnpm-compose, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pnpm-compose.packages.${system}.default
          ];
        };
      });
}
```

## Configuration

**Zero-config by default**: pnpm-compose auto-detects composed repos from your `.gitmodules` file. No configuration needed for most setups.

**Optional exclusions**: Create `pnpm-compose.config.ts` only if you need to exclude certain submodules:

```ts
export default {
  exclude: ['submodules/docs'], // Paths to skip
}
```

## Principles

- Composable
- Efficient (incremental updates, skip unnecessary work)
- Idempotent & deterministic
- Enforce strict alignment between composed repos

## References

Related GitHub issues discussing the underlying problem:

**pnpm**

- [#10157 - Support resolving `*` alongside `workspace:*` for git submodule integration](https://github.com/pnpm/pnpm/issues/10157) - Core issue: can't use `workspace:*` in submodules without breaking standalone usage
- [#10302 - Extending child pnpm workspaces](https://github.com/pnpm/pnpm/issues/10302) - Nested monorepos can't reference child `pnpm-workspace.yaml` files
- [#1366 - Link dependencies from shared node_modules](https://github.com/pnpm/pnpm/issues/1366) - Foundational discussion on multi-package repository challenges

**Bun**

- [#5450 - Separate lockfiles for monorepo packages](https://github.com/oven-sh/bun/issues/5450) - Git submodules in monorepos need independent lockfiles for proper caching
