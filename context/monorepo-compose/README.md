# Multi-Repo Composition (Megarepo-first)

Compose multiple repos as peers with simple relative paths, while keeping each
repo fully standalone. The target workflow uses a megarepo root plus a small
local Nix workspace to keep evals fast and pure.

## Core Principles

1. **Megarepo root with `repos/`**: Members live under `repos/` in the megarepo root.
2. **Simple `../` paths**: Dependencies use relative paths that work across tools (bun, nix, node).
3. **Single source of truth**: Shared dependency versions live in effect-utils.
4. **Independent repos**: Each repo keeps its own git history and CI.

## Quick Start (Target)

1. Create a megarepo root (with `megarepo.json`) and sync repos.
2. Run `mr generate nix` to create `.envrc.generated.megarepo` and the local workspace flake.
3. Use the minimal `.envrc` pattern (see below).
4. Run builds from the local megarepo workspace path.

Minimal `.envrc` in a repo:

```bash
source_env_if_exists ./.envrc.generated.megarepo
use devenv
```

Build using the local workspace path:

```bash
nix build "path:$MEGAREPO_NIX_WORKSPACE#packages.<system>.my-repo.<target>"
```

Outside a megarepo, build normally:

```bash
nix build .#<target>
```

## Local Overrides (Peer Repos)

When you need to override a dependency (e.g. effect-utils) with a local checkout:

```bash
devenv shell --override-input effect-utils path:../effect-utils
```

This keeps `devenv.yaml` pinned to GitHub for CI while enabling local iteration.

## Further Reading

- [Architecture](./architecture.md) - Composition structure
- [Patterns](./patterns.md) - Composition conventions and examples
- [Nix Flake Setup](./nix-flake-setup.md) - Flake-based setup
- [devenv Setup](./devenv-setup.md) - devenv-based setup
