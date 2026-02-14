# Repository Composition

Compose multiple repos into a unified development environment using megarepo. Each repo remains independent while sharing dependencies through relative paths.

## Environment Variables

Set by devenv and megarepo:

| Variable         | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `DEVENV_ROOT`    | Path to the devenv project root (provided by devenv)                   |
| `MEGAREPO_STORE` | Path to global megarepo store (`~/.megarepo/`) for repo symlink target |

## Further Reading

- [Megarepo Spec](../../packages/@overeng/megarepo/docs/spec.md) - Full specification
- [Setup Guide](../nix-devenv/setup-guide.md) - File templates and setup for new megarepos
