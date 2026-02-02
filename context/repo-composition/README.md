# Repository Composition

Compose multiple repos into a unified development environment using megarepo. Each repo remains independent while sharing dependencies through relative paths.

For setup instructions and file templates, see [setup-guide](../nix-devenv/setup-guide.md).

## Core Principles

1. **Megarepo root with `repos/`** - Members live under `repos/` as symlinks to the global store
2. **Simple `../` paths** - Dependencies use relative paths that work across tools (bun, nix, node)
3. **Single source of truth** - Shared dependency versions live in effect-utils
4. **Independent repos** - Each repo keeps its own git history and CI

## Megarepo Commands

| Command              | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `mr sync`            | Materialize repos from lock file                         |
| `mr sync --frozen`   | CI mode: fail if lock is stale                           |
| `mr update`          | Re-resolve refs and update lock                          |
| `mr update <member>` | Update specific member                                   |
| `mr generate nix`    | Generate `.envrc.generated.megarepo` and workspace flake |
| `mr status`          | Show megarepo state                                      |
| `mr pin <member>`    | Pin member to current commit                             |
| `mr unpin <member>`  | Remove pin                                               |

> **Auto-setup:** On fresh clone/worktree, `mr sync` runs automatically during devenv shell entry. Use `mr status` to check sync state or `mr status --output json` for scripting.

## Environment Variables

Set by `mr env` and `.envrc.generated.megarepo`:

| Variable                  | Description                          |
| ------------------------- | ------------------------------------ |
| `MEGAREPO_ROOT_OUTERMOST` | Path to outermost megarepo root      |
| `MEGAREPO_ROOT_NEAREST`   | Path to nearest megarepo root        |
| `MEGAREPO_NIX_WORKSPACE`  | Path to generated nix workspace      |
| `MEGAREPO_MEMBERS`        | Comma-separated list of member names |

## Further Reading

- [Architecture](./architecture.md) - Workspace structure and composition hierarchy
- [Patterns](./patterns.md) - Genie patterns, dependency conventions, TypeScript config
- [Megarepo Spec](../../packages/@overeng/megarepo/docs/spec.md) - Full specification
