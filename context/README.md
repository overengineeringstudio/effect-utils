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

- [Megarepo Spec](../packages/@overeng/megarepo/docs/spec.md) - Full specification

### [bun-cli-build/](./bun-cli-build/)

Building Bun-compiled TypeScript CLIs with Nix.

### [cli-design/](./cli-design/)

CLI output style guide.

### [oxc-config/](./oxc-config/)

OXC (oxlint, oxfmt) configuration.

### [testing/](./testing/)

Testing patterns and conventions.

### [otel/](./otel/)

OpenTelemetry observability stack (Collector + Tempo + Grafana).

- [README.md](./otel/README.md) - Quick start, env vars, shell helper
- [spec.md](./otel/spec.md) - Architecture, port allocation, forward compatibility
- [dashboards.md](./otel/dashboards.md) - Grafonnet dashboards, span conventions

## Workflows

### [workflows/](./workflows/)

- [cron/](./workflows/cron/) - Consistency checks and dependency update workflows

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
