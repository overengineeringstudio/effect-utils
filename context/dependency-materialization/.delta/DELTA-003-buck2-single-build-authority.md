# DELTA-003: Legacy dependency adapters overlap Buck2 build authority

Status: open

## Divergence

[Decision 0010](../.decisions/0010-select-buck2-build-authority.md) selects
Buck2 as the repo-local build authority, but the consumers of two adapter
families still use other build paths: composed pnpm source staging plus Nix
prepared dependencies, and workspace-staged CI runtime helpers. These adapters
are temporary compatibility surfaces. They may receive correctness fixes for
existing consumers but must not gain consumers, broader APIs, or a Buck2
translation of their internal abstractions.

## VRS

- [DMP.BUCK-R06](../05-buck2-evidence/requirements.md) requires Buck2 to be the
  only build authority for consumers in its declared scope.
- [DMP-R11 and DMP-R24](../requirements.md) require one Authoritative
  Materializer and reject a parallel steady-state topology authority.
- [Decision 0010](../.decisions/0010-select-buck2-build-authority.md) selects
  Buck2 and defines its boundary with Nix and pnpm.
- [The Buck2 spec](../05-buck2-evidence/spec.md) records the current
  evidence-only implementation boundary.

## Legacy Adapter Census

### Composed pnpm source staging and prepared dependencies

| Surface                 | Owned implementation                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genie public projection | `workspaceClosureReference` in `packages/@overeng/genie/src/runtime/package-json/mod.ts`; `pnpmSourceInputStagePath` and `projectPnpmSourceInputs` in `packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts`; re-exports in `packages/@overeng/genie/src/runtime/mod.ts` and `genie/external.ts` |
| Live source generations | `sourceInputPaths`, `stageSourceInputs`, `checkSourceInputs`, and `gcSourceInputs` in `nix/devenv-modules/tasks/shared/pnpm.nix`; `nix/devenv-modules/tasks/shared/stage-pnpm-source-inputs.mjs`; `.devenv/pnpm-source-inputs`                                                                        |
| Prepared-deps contract  | `workspaceManifestContract.sourceInputStagePath` and `workspaceManifestContract.sourceInputPaths` plus manifest-alias creation in `nix/workspace-tools/lib/mk-pnpm-cli.nix`                                                                                                                           |
| Prepared-deps relinking | `sourceProjectDirForLocator`, `.package-map.json` source selection, and local-source relinking in `nix/workspace-tools/lib/mk-pnpm-deps.nix`                                                                                                                                                          |
| Focused evidence        | `nix/devenv-modules/tasks/shared/tests/pnpm-source-input-staging.test.sh`, `pnpm-source-input-refresh.integration.test.sh`, the source-input cases in `pnpm-task-smoke.test.sh`, and `nix/workspace-tools/lib/mk-pnpm-cli/tests/fixtures/downstream`                                                  |

### Workspace-staged CI runtime helpers

| Surface                            | Owned implementation                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Helper preparation and consumption | `preparedCiRuntimeScriptsDir` and helper references in `genie/ci-workflow/shared.ts`, `genie/ci-workflow/setup.ts`, and `genie/ci-workflow.ts`; generated `.github/workflows/ci.yml` consumers under `.genie-ci-runtime` |
| Admission validation               | `preparedCiRuntimeScriptsPath`, `prepareCiScriptsStepName`, `installNixInvalidatesPreparedCiRuntime`, and `validatePreparedCiRuntimeScriptsSetup` in `packages/@overeng/genie/src/runtime/github-workflow/mod.ts`        |
| Focused evidence                   | prepared-runtime cases in `packages/@overeng/genie/src/runtime/github-workflow/github-workflow.unit.test.ts` and `ci-workflow-helpers.unit.test.ts`                                                                      |

No file or symbol in this census is a permanent Buck2 API. Historical
changelog and decision records remain historical evidence after removal.

## Resolution Approach

Move only the consumers of the surfaces in this census directly to declared
Buck2 dependency/product artifacts. Nix activation and deployment consume
content-addressed artifact paths and must not invoke Buck2 against a mutable
checkout. Censused CI consumers invoke Buck2 targets or repository-owned
commands directly, without copying helper scripts through a workspace path that
setup steps can invalidate.

Delete the adapters in one contraction stack after consumer cutover:

1. remove downstream generation and consumption of the source-input contract;
2. remove the Genie projection APIs and prepared-deps contract reader;
3. remove live source-generation staging and its state;
4. remove prepared-deps source-locator relinking and its compatibility fixtures;
5. remove CI helper staging and its admission validator together; and
6. update the live-pnpm and prepared-deps VRS to remove the retired mechanisms.

Do not remove the CI admission validator alone: that weakens the existing
adapter without reducing the helper lifecycle it protects.

## Direction

remove implementation after Buck2 consumer cutover

## Resolution Signal

- Every consumer of a composed-source or prepared-dependency surface in this
  census has a declared Buck2 target that produces the corresponding immutable
  dependency or product artifact and evidence naming `buck2` as materialization
  authority.
- Consumer-level conformance covers lifecycle-script refusal, selected source
  identity, nested and repeated peer contexts, paths containing parentheses,
  traversal refusal, native dependency classification, and supported Linux and
  Darwin targets.
- A repository-wide consumer census fails CI if a new reference to
  `projectPnpmSourceInputs`, `workspaceClosureReference`,
  `workspaceManifestContract.sourceInputStagePath`,
  `workspaceManifestContract.sourceInputPaths`, `.devenv/pnpm-source-inputs`, or
  `.genie-ci-runtime` appears outside this delta or historical changelog and
  decision records.
- The contraction gate runs the following zero-match census after removing this
  delta; any output fails the gate:

  ```sh
  rg -n \
    --glob '!CHANGELOG.md' \
    --glob '!context/**/.decisions/**' \
    '(projectPnpmSourceInputs|workspaceClosureReference|sourceInputStagePath|sourceInputPaths|\.devenv/pnpm-source-inputs|\.genie-ci-runtime)' \
    .
  ```

- After consumer cutover, the same census requires zero non-historical matches
  and every implementation and focused-evidence surface listed above is absent.
- The generated workflow freshness check, Buck2 tests, supported-platform
  canaries for the censused consumers, and the repository `check:all` gate pass
  without any censused adapter.
- This delta is removed in the same contraction stack.
