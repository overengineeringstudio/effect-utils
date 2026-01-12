# Multi-Repo Composition with dotdot

Pattern for composing multiple repos via dotdot with unified dependency management.

## Problem

When developing across repos (e.g., app + shared libraries), you want local changes immediately available without publishing. Traditional approaches (git submodules, monorepos, manual scripts) have significant trade-offs.

## Solution

| Component   | Purpose                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| **dotdot**  | Multi-repo workspace management with flat peer repos using `../` paths           |
| **genie**   | TypeScript-based config generation (package.json, tsconfig)                      |
| **devenv/Nix** | Distributes CLI tools (dotdot, genie) before `bun install` runs               |

> **Important:** genie CLI is installed via Nix/devenv, not as an npm dependency. The genie lib types are accessed via Node.js subpath imports (`#genie/*`).

## Core Principles

1. **Flat peer repos**: All repos live as siblings in a workspace, not nested inside each other.

2. **Simple `../` paths**: Dependencies use relative paths that work across all ecosystems (bun, cargo, nix).

3. **Single source of truth**: Dependency versions live in the lowest common ancestor. effect-utils defines versions for Effect ecosystem; parent repos only add packages not in effect-utils.

4. **Independent repos**: Each repo stays independent with separate git history, access control, and CI.

## Quick Start

### 1. Initialize a workspace

```bash
mkdir my-workspace && cd my-workspace
dotdot init
```

### 2. Clone your main repo

```bash
git clone git@github.com:org/my-app.git
```

### 3. Sync dependencies

```bash
dotdot sync  # Clones all declared dependencies
```

### 4. Set up Nix/devenv (optional)

Create `devenv.yaml`:

```yaml
inputs:
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
  effect-utils:
    url: github:overengineeringstudio/effect-utils
```

Create `devenv.nix`:

```nix
{ pkgs, inputs, ... }:
let
  cliPackages = inputs.effect-utils.lib.mkCliPackages {
    inherit pkgs;
    pkgsUnstable = pkgs;
  };
in
{
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    cliPackages.genie
    cliPackages.dotdot
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

### 5. Create dotdot config

Create `my-app/dotdot.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json",
  "repos": {
    "effect-utils": {
      "url": "git@github.com:overengineeringstudio/effect-utils.git",
      "install": "bun install",
      "packages": {
        "@overeng/utils": { "path": "packages/@overeng/utils" },
        "@overeng/genie": { "path": "packages/@overeng/genie" }
      }
    }
  }
}
```

### 6. Use path dependencies

In your `package.json`:

```json
{
  "dependencies": {
    "@overeng/utils": "../@overeng/utils"
  }
}
```

## Commands

```bash
dotdot init           # Initialize workspace
dotdot status         # Show repo states
dotdot sync           # Clone missing repos, checkout pinned revisions
dotdot update-revs    # Pin current HEAD revisions to configs
dotdot pull           # Pull all repos
dotdot tree           # Show dependency tree
dotdot link           # Create symlinks from packages configs
dotdot exec -- cmd    # Run command in all repos
```

## Further Reading

- [SKILL.md](./SKILL.md) - Agent instructions for working with dotdot workspaces
- [Architecture](./architecture.md) - How composition works, directory structure
- [Patterns](./patterns.md) - Composition best practices, troubleshooting
- [Nix Setup](./nix-setup.md) - Alternative Nix configurations (pure flakes)
- [dotdot README](../../packages/@overeng/dotdot/README.md) - Full CLI docs
- [genie README](../../packages/@overeng/genie/README.md) - Config generator docs
