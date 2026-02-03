# Nix & Devenv Specification

## Context

We manage multiple interconnected repositories using a megarepo approach. Each repo can be developed standalone or composed with others into a unified workspace. The goal is fast, reproducible development environments with minimal friction—whether you're working on a single repo or across the entire ecosystem.

## Assumptions

- A1 - Megarepo (`mr`) is the standard repo management tool; repos declare dependencies via `megarepo.json` and use `mr sync` to materialize them.
- A2 - Devenv is the primary development workflow; flakes define packages, devenv consumes them via inputs.
- A3 - Shared infrastructure (devenv modules, CLI tools, nix helpers) lives in `effect-utils`.

## Requirements

### Must be consistent

- R1 - Nested megarepos must be independent: a child megarepo must work without its parent's context (no reliance on parent's env vars, workspace, or store paths).
- R2 - Share devenv task modules via `effect-utils/devenvModules`; avoid repo-specific implementations of common patterns.
- R3 - Use namespaced task names (e.g. `pnpm:install`, `ts:build`, `check:all`) consistently across repos.

### Must be clean and deterministic

- R4 - Keep builds pure by default; no `--impure` for normal flows.
- R5 - Keep clean builds deterministic and cache-friendly.
- R6 - Avoid duplicated tooling outputs (e.g. `result` links); use `--no-link`.
- R7 - The megarepo store (`~/.megarepo/`) lives outside the repo; Nix builds must not depend on store symlinks.

### Must be fast

- R8 - Build dirty/local changes without committing.
- R9 - Avoid copying large trees (e.g. `node_modules`) into Nix store; avoid `path:.` eval hashing huge ignored trees; stay fast (< 1s for CLI builds).
- R10 - Warm devenv shells must initialize in < 500ms. Use git hash caching to skip unchanged setup tasks.
- R11 - Tasks must be incremental: use `status` checks to skip up-to-date work, `execIfModified` for file-triggered tasks.

### Must be efficient

- R12 - Shell environments must remain stable when nothing meaningful has changed. Avoid spurious re-evaluations triggered by file timestamp changes, syncs, or other non-semantic modifications. Flake inputs and overrides should use content-addressed references (e.g. `git+file:`) rather than timestamp-sensitive ones where possible.

### Must be resilient

- R13 - Devenv shell entry must not be blocked by transient task failures (e.g. TypeScript errors). The shell must still load, while failures remain visible and easy to run explicitly.

### Must be simple

- R14 - In devenv, run in-repo CLIs via `bun` from source; keep flake outputs strict for builds. Exception: bootstrap tasks (e.g. `megarepo:sync`) that run before `node_modules` exist may use `nix run git+file:$PWD#<pkg>` to build and run the CLI via Nix.
- R15 - Keep `.envrc` minimal; follow the standard pattern: source `.envrc.generated.megarepo`, then `use devenv`.
- R16 - Use devenv tasks as the task runner with the `dt` wrapper for dependency resolution.
- R17 - Avoid redundant implementations; prefer shared modules in `effect-utils/devenvModules`.

### Must be clear

- R18 - Provide clear error messages for missing lockfiles / stale dependency hashes. Make refresh easy.
- R19 - Task descriptions must be concise and discoverable via `dt --help` or shell completions.

### Must be verified

- R20 - Nested megarepos must work independently of their parent megarepo.
- R21 - Devenv can override flake inputs for local development (`--override-input`).
- R22 - Cover megarepo workspace builds vs standalone `mr sync` in tests.

## See Also

- [bun-cli-build](../bun-cli-build/README.md) - CLI-specific build patterns using `mkBunCli`
