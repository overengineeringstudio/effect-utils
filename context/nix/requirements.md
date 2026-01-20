# Nix Requirements

## Must be consistent

- R1 - Pin `nixpkgs` once for all megarepo members via a workspace flake.
- R2 - Keep the workspace flake under the megarepo root and reference it via local path inputs.
- R3 - Keep repos self-contained outside the megarepo (no hard dependency on workspace-only paths).

## Must be clean and deterministic

- R4 - Keep builds pure by default; no `--impure` for normal flows.
- R5 - Keep clean builds deterministic and cache-friendly.
- R6 - Avoid duplicated tooling outputs (e.g. `result` links); use `--no-link`.
- R7 - The megarepo store lives outside the repo; Nix builds must not depend on store symlinks. Use a generated local workspace when needed.

## Must be fast

- R8 - Build dirty/local changes without committing.
- R9 - Avoid copying large trees (e.g. `node_modules`) for dirty builds; stay fast (< 1s build time for most cases e.g. CLI builds).

## Must be simple

- R10 - Keep `.envrc` / `devenv` setup minimal; avoid complex overrides or multi-branch logic.
- R11 - Use standard APIs (e.g. `use devenv`); avoid custom overrides or hacks.

## Must be clear

- R12 - Provide clear error messages for missing lockfiles / stale dependency hashes.

## Must be verified

- R13 - Work in effect-utils and peer repos, with both flake and devenv entrypoints.
- R14 - Support both flakes and devenv as primary workflows.
- R15 - Cover clean vs dirty builds and peer-repo flows in tests.
