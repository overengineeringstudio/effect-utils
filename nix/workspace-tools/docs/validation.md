# Validation and Findings

## Validation

- `direnv reload` succeeds across:
  - `effect-utils` (clean + `NIX_CLI_DIRTY=1`)
  - `schickling.dev` (clean + dirty)
  - `livestore` (clean + dirty)
- Staged workspace now includes `packages/@overeng/dotdot/src/lib/result-utils.ts`
  even when `NIX_CLI_DIRTY_PACKAGES` uses `*-dirty` names.

## Findings

- `direnv exec . true` still fails in effect-utils due to TS41 diagnostics from
  the Effect language service plugin in dotdot:
  - `packages/@overeng/dotdot/src/lib/loader.ts`
  - `packages/@overeng/dotdot/src/lib/workspace-service.ts`
  - `packages/@overeng/dotdot/src/test-utils/setup.ts`
    This is a known separate issue (Effect LSP/TS41) and not a staging failure.

## Notable Fixes

- Updated `devenv.nix` bunDeps hashes to match flake builds:
  - genie: `sha256-o3JZv9lq3IXroGSmvQK7yBePEHVWxU/ZwC3lrEcr3lo=`
  - dotdot: `sha256-lAvLdjaEG2NRLyP7Y12w7Arlua5rkMnrVJEeQXgM3Ms=`
    This removed `@overeng/cli-ui` missing module errors in devenv builds.
