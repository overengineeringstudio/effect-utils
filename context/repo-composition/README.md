# Repository Composition

Compose multiple repos into a unified development environment using megarepo. Each repo remains independent while sharing dependencies through relative paths.

For megarepo CLI usage (`mr sync`, `mr pin`, store layout, etc.), see the `sk-megarepo` skill in dotfiles.
For composition patterns (package structure, dependency conventions, CI), see the `sk-repo-composition` skill in dotfiles.

This directory contains effect-utils-specific details not covered by the skills.

## Environment Variables

Set by devenv and megarepo:

| Variable         | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `DEVENV_ROOT`    | Path to the devenv project root (provided by devenv)                   |
| `MEGAREPO_STORE` | Path to global megarepo store (`~/.megarepo/`) for repo symlink target |

## Further Reading

- [Patterns](./patterns.md) - Effect-utils-specific patterns and workarounds
- [Megarepo Spec](../../packages/@overeng/megarepo/docs/spec.md) - Full specification
- [Setup Guide](../nix-devenv/setup-guide.md) - File templates and setup for new megarepos
