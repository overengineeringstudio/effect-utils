# Nix Requirements

## Must be consistent

- R1 - Each repo pins its own `nixpkgs` (alignment across repos is optional).
- R2 - Keep the local workspace flake under each megarepo root at `.direnv/megarepo-nix/workspace` (nested roots can override).
- R3 - Keep repos self-contained outside the megarepo (no hard dependency on workspace-only paths).

## Must be clean and deterministic

- R4 - Keep builds pure by default; no `--impure` for normal flows.
- R5 - Keep clean builds deterministic and cache-friendly.
- R6 - Avoid duplicated tooling outputs (e.g. `result` links); use `--no-link`.
- R7 - The megarepo store lives outside the repo; Nix builds must not depend on store symlinks. Use a generated local workspace when needed.

## Must be fast

- R8 - Build dirty/local changes without committing.
- R9 - Avoid copying large trees (e.g. `node_modules`) for dirty builds; avoid `path:.` eval hashing huge ignored trees by preferring a filtered local workspace; stay fast (< 1s build time for most cases e.g. CLI builds).

## Must be simple

- R10 - Keep `.envrc` / `devenv` setup minimal; avoid complex overrides or multi-branch logic.
- R11 - Use standard devenv/flake APIs so usage feels like normal devenv or nix flakes without foot-guns.
- R12 - Avoid redundant implementations; prefer shared, single-path helpers.

## Must be clear

- R13 - Provide clear error messages for missing lockfiles / stale dependency hashes. Needs to be easy to refresh the hashes.

## Must be verified

- R14 - Work in effect-utils and peer repos, with both flake and devenv entrypoints.
- R15 - Support both flakes and devenv as primary workflows.
- R16 - Cover megarepo workspace builds vs standalone flake builds, plus peer-repo flows, in tests.
- R17 - Ensure devenv/flake interop is reliable (path inputs, lockfiles, and required devenv files must work without hacks).
