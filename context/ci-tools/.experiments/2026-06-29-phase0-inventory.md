# Phase 0 Inventory Kickoff

## Status

Partial inventory captured from public repository state on 2026-06-29.

Issue #868 names `context/ci-tools/vision.md` and
`context/ci-tools/requirements.md` as owning VRS artifacts, but this branch did
not contain `context/ci-tools/` when Phase 0 began. A local git commit
(`1173f06d`, `docs: add ci-tools deploy preview VRS`) contains the intended VRS
namespace. This milestone restores only non-protected VRS artifacts until the
protected `vision.md` and `requirements.md` import is explicitly confirmed.

## Evidence

- Issue #868 defines the target migration: hard-rename `@overeng/workflow-report`
  to `@overeng/ci-tools` and move deploy preview behavior into an Effect runtime.
- `package.json.genie.ts` imports the current package generator from
  `packages/@overeng/workflow-report/package.json.genie.ts`.
- `pnpm-workspace.yaml`, `pnpm-install-contract.json`, `tsconfig.all.json`, and
  their Genie sources still reference `packages/@overeng/workflow-report`.
- `flake.nix` and `nix/workspace-tools/lib/mk-cli-packages.nix` still expose the
  Nix package as `workflow-report`.
- `packages/@overeng/workflow-report/nix/build.nix` builds the
  `workflow-report` binary from
  `packages/@overeng/workflow-report/bin/workflow-report.ts`.
- `genie/deploy-preview/shared.ts` and `genie/ci-workflow/reporting.ts` import
  workflow-report markers and helpers from the current package.
- Generated workflow deploy-preview logic still lives in
  `genie/deploy-preview/netlify.ts`, `genie/deploy-preview/vercel.ts`, and
  `.github/workflows/ci.yml.genie.ts`.

## Current Netlify Behavior

- `nix/devenv-modules/tasks/shared/netlify.nix` owns Netlify deploy execution.
- It expects `NETLIFY_AUTH_TOKEN`, checks the local static directory, parses
  `type=prod|pr|draft` task input, computes an alias, and runs
  `netlify deploy --dir ... --no-build --json`.
- On the known unauthorized/project lookup path, it calls Netlify CLI API
  commands for `getCurrentUser` and `getSite` diagnostics.
- It validates deploy JSON fields, derives raw/final URLs, and emits deploy
  metadata through the shared deploy-task helper.
- Current behavior is therefore shell/Nix-owned with CLI deploy and CLI API
  diagnostics.

## Current Vercel Behavior

- `nix/devenv-modules/tasks/shared/vercel.nix` owns Vercel deploy execution.
- Build mode runs `vercel pull`, local `vercel build`, and
  `vercel deploy --prebuilt`; static mode packages a local directory as Build
  Output API v3 before `vercel deploy --prebuilt`.
- It requires `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` through
  configurable environment variable names.
- It parses `type=prod|pr|preview`, derives aliases for configured targets, and
  extracts the deploy URL from CLI output.
- Current behavior avoids provider-side builds, but deploy and alias semantics
  remain shell/Nix-owned and CLI-driven.

## API-First vs CLI-Fallback Starting Point

- API-first candidates from the VRS and current code: provider auth
  diagnostics, project/site lookup, alias validation, and best-effort cleanup.
- CLI fallback candidates from the VRS and current code: Netlify local static
  upload/deploy, Vercel prebuilt/static deploy upload, and any provider-specific
  upload flow where direct API replication would add disproportionate risk.

## Open Questions

- Should this branch import the protected `context/ci-tools/vision.md` and
  `context/ci-tools/requirements.md` from `1173f06d` verbatim, or should those
  protected artifacts be reviewed and edited before landing?
- Should Phase 1 preserve a temporary compatibility binary or make `ci-tools`
  the only binary immediately? Issue #868 says hard rename, while the restored
  spec allows workflow-report commands under the new CLI surface.
