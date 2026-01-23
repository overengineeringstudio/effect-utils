# Context Reference

This directory contains focused references for patterns and technologies used in this workspace.

## Core Documentation

### [nix-devenv/](./nix-devenv/)
Nix and devenv setup, requirements, and patterns.
- [setup-guide.md](./nix-devenv/setup-guide.md) - File templates and setup for new megarepos
- [requirements.md](./nix-devenv/requirements.md) - Assumptions and requirements spec
- [tasks.md](./nix-devenv/tasks.md) - Devenv tasks, `dt` wrapper, shared modules
- [flake-packages.md](./nix-devenv/flake-packages.md) - Flake package definitions

### [repo-composition/](./repo-composition/)
Multi-repo composition with megarepo.
- [README.md](./repo-composition/README.md) - Quick start and commands
- [architecture.md](./repo-composition/architecture.md) - Workspace structure
- [patterns.md](./repo-composition/patterns.md) - Genie patterns, dependency conventions

### [bun-cli-build/](./bun-cli-build/)
Building Bun-compiled TypeScript CLIs with Nix.

### [cli-design/](./cli-design/)
CLI output style guide.

### [mono-cli/](./mono-cli/)
The `@overeng/mono` CLI framework for monorepo commands.

### [oxc-config/](./oxc-config/)
OXC (oxlint, oxfmt) configuration.

### [testing/](./testing/)
Testing patterns and conventions.

## Workflows

### [workflows/](./workflows/)
- [beads.md](./workflows/beads.md) - Beads workflow
- [plan-files.md](./workflows/plan-files.md) - Plan file conventions

## Workarounds

### [workarounds/](./workarounds/)
Temporary workarounds for tool issues (bun, pnpm).

## Planned

### [planned/](./planned/)
Specs for future work.

## Reference Examples

### [effect/](./effect/)
Effect-related examples (socket, etc.).

### [opentui/](./opentui/)
OpenTUI integration example.
