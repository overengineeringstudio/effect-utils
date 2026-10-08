# Spec: repository CI

This document specifies the repository-local GitHub Actions control plane for effect-utils.

## Status

Active.

## Scope

**Defines:** admitted events, lane cadence, check-run and check-suite outcomes, required-check derivation, measurement cost policy, and generated-file authority.

**Does not define:** cross-repository policy, organization rulesets, runner-fleet operations, or the implementation contract of individual build and test tools.

Requirements are in [requirements.md](./requirements.md), domain terms are in [ontology.md](./ontology.md), and the event/cadence choice is recorded in [.decisions/0001-event-admission-and-performance-dispatch.md](./.decisions/0001-event-admission-and-performance-dispatch.md).

## Event admission

The generated CI and Empirical Proofs workflows partition revision validation from empirical evidence:

| Event               | Admitted shape                      | Meaningful outcome                                                                    |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `pull_request`      | `opened`, `reopened`, `synchronize` | Run quality/source-policy feedback; heavy product jobs publish skipped checks.        |
| `pull_request`      | `labeled` with `ci:heavy-proofs`    | Run only credential-free empirical proofs for the labeled PR head.                    |
| `merge_group`       | `checks_requested`                  | Validate the queue's combined head with every merge-required product invariant.       |
| `push`              | `main`                              | Run eligible main-only publication and empirical work, not duplicate heavy products.  |
| `schedule`          | `17 3 * * *`                        | Run empirical proofs, deterministic measurements and the aggregate trend report.      |
| `workflow_dispatch` | explicit operator request           | Run the requested CI/measurement work, including `devenv-perf` and baseline backfill. |

`pull_request:labeled` is admitted only by Empirical Proofs and selects empirical lanes only when the applied label is `ci:heavy-proofs`. Other label events launch no lanes. CI does not admit label events, and proof concurrency is isolated by workflow and event scope, so label churn cannot cancel code checks. A labeled PR also runs empirical proofs on subsequent code pushes. The credentialed remote-cache proof stays in CI on trusted main push/dispatch regardless of labels.

Empirical Proofs emits no ordinary required contexts. Source measurements are partitioned: required `source-shape` runs on PR and merge-group revisions in CI, while `main/source-shape` runs on main push/nightly/dispatch alongside closure/performance artifacts and the aggregate report. A proof-workflow skip therefore cannot replace failed code evidence.

Source measurement dispatch retains historical backfills on any ref, including nonempty `measurement_baseline_ref`; this credential-free measurement exception does not admit the three empirical proof jobs or credentialed remote proof on non-main dispatches. Report publication remains main-only.

Some control-event workflows admit actions where the requested side effect is validly unnecessary. Those workflows keep the job alive and gate only the conditional step, so GitHub produces a successful check suite rather than an absent required check. The auto-review workflow is the current example: its review-request step is conditional, while the job itself always concludes.

## Lane semantics

A **lane** is one workflow job (or a job matrix) with one declared cadence and outcome.

- Quality and source-policy lanes give PR feedback and run again on the merge group's combined head.
- Heavy unit, browser, Rust, Weaver, Restate, from-source product, inert-admission, and Storybook-play lanes run only for `merge_group`; they are not duplicated on ordinary PR pushes or main pushes.
- Main-only lanes run only after changes reach `main` or through an authorized dispatch.
- `bootstrap-cold-proof`, `test-megarepo-cold-gc`, and `nix-closure-sizes` run in Empirical Proofs on trusted main push, nightly, or main dispatch, and on PRs carrying `ci:heavy-proofs`; their PR variants have no writer credentials.
- `devenv-perf` is dispatch-only. It has no pull-request label coupling and does not run on the schedule.
- `ci/measurements-report` aggregates the measurement artifacts produced by the current push, schedule, or dispatch and remains advisory.

The schedule covers empirical cold-bootstrap/cold-GC authority and deterministic trends, not a nightly rerun of product CI. The empirical lanes do not block ordinary PR merges; build-products, frozen-lockfile checks, generated freshness, and ordinary product tests remain merge-blocking.

The Linux `quality` job emits `pr/quality` and shares one checkout, Nix/devenv setup, and diagnostics lifecycle across TypeScript, format/lint/generated freshness, frozen-lockfile validation, bundle smoke, native dependency policy, shell-entry checks, and the CI-runtime/downstream-flake regressions. Each invariant retains a named failing step; the lane stops after a failure, while failure summaries and diagnostic artifacts still run. The job declares reader-only Buck cache posture.

The downstream-flake regression copies source inputs, not transient `.editor-view` payloads produced by preceding quality steps. Its disposable checkout therefore excludes the immutable editor backing store along with other build and dependency state.

The inert-admission lane rejects tracked editor backing stores and product payloads under `nix/buck2-products`. Nix recipe admission derives from the same `rootNixSourceGlobs` that declares `//:nix_sources`; adding a Nix source does not require an independent filename exception. Non-Nix product metadata, generators, and contract scripts retain an exact allowlist.

Nix candidates must be Git-classified text of at most 256 KiB. Admission rejects any path component matching `buck-out`, `.editor-view`, `result*`, `dist`, `node_modules`, `storybook-static`, `tmp`, `target`, or `.devenv`, regardless of filename suffix. Size and text checks read indexed blobs rather than mutable working-tree content.

## Checks and ruleset

GitHub creates a check run for each materialized job and groups runs from one workflow execution in a check suite. Branch protection names required check-run contexts, not source-level job keys.

`genie/ci.ts` is the typed inventory for workflow job keys and required contexts:

- `CORE_CI_JOB_NAMES` and `EXTRA_CI_JOB_NAMES` inventory product, source-policy, and empirical lanes;
- `MAIN_ONLY_CI_JOB_NAMES` contains jobs that do not materialize on pull requests;
- `OPT_IN_CI_JOB_NAMES` contains `devenv-perf`, whose dispatch-only cadence prevents it from being required;
- `advisoryCIJobNames` contains report/notification jobs whose conclusions do not gate merge;
- `REQUIRED_CI_JOB_NAMES` contains the default-ref policy job plus core and extra product jobs, excluding `EMPIRICAL_PROOF_CI_JOB_NAMES`, opt-in, main-only, and advisory jobs;
- `STANDALONE_REQUIRED_CI_JOB_NAMES` contains merge-blocking jobs outside `ci.yml` (currently `test-storybook-plays`); they retain PR-triggered skipped check contexts and execute on `merge_group`, with no path filter;
- `ciJobCheckContexts` maps static Linux/Darwin unit-test jobs to their retained runner-qualified context names. The jobs do not use a matrix: GitHub evaluates a job-level skip before matrix expansion, which would otherwise omit both required PR contexts and block queue admission.

The main-only exclusion is deliberate and fixes the absent-check failure mode: requiring `test-integration-notion`, `test-live-deploy-ci-tools`, or `deploy-storybooks` on a pull request would leave branch protection waiting for check runs that the workflow never creates.

`.github/repo-settings.json.genie.ts` derives the repository ruleset directly from `requiredCIJobs` (the expanded `REQUIRED_CI_JOB_NAMES` plus `STANDALONE_REQUIRED_CI_JOB_NAMES`). The same ruleset requires GitHub's native merge queue with `SQUASH`, `ALLGREEN`, build concurrency one, merge limit one, and a 180-minute check-response timeout. Required contexts are unchanged by the queue cutover: a PR's skipped heavy checks permit queue admission, not direct merge; the native queue must obtain successful real heavy-job results on its synthetic combined head. There are no admission labels, sentinel successes, or per-PR heavy cohorts.

Linux `test` and Darwin `test-macos` are physical workflow jobs with static check names `test (namespace-profile-linux-x86-64)` and `test (namespace-profile-macos-arm64)`. Both retain canonical pipeline job `test` with their respective runner dimension, so queue validation and historical trace identities agree. Darwin retains its native/compiled product smoke after unit tests.

## Storybook previews

Storybook deploys split by trust. `deploy-storybooks` in the CI workflow is main-only and deploys production with `NETLIFY_AUTH_TOKEN`. PR previews use two workflows outside CI, so preview latency and CI conclusions stay independent:

| Workflow                       | Event                       | Trust                   | Outcome                                                                                                                    |
| ------------------------------ | --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `storybook-preview-build.yml`  | `pull_request`              | PR code, no secrets     | `build-storybooks` runs `netlify:stage` and uploads the static output as the `netlify-preview-static` artifact.            |
| `storybook-preview-deploy.yml` | `workflow_run` of the build | default-branch revision | Resolves the PR from the event payload, deploys the artifact with `netlify:deploy-staged`, and updates the sticky comment. |

The deploy workflow treats the artifact as data: it checks out `github.workflow_sha`, never the PR head, and hands the static files to `netlify deploy --no-build`. PR number and head SHA come from `github.event.workflow_run` and the GitHub API; a closed PR or a head that moved past the triggering run is skipped. Fork PRs are not deployed. `NETLIFY_AUTH_TOKEN` exists only in the deploy step environment, and only `publish-preview-comment` has `pull-requests: write`. Because `workflow_run` workflows run from the default branch, changes to the deploy workflow take effect after they merge.

The deploy target set is the artifact's top-level directory names, not the default branch's Storybook list, so a PR that adds a Storybook package gets its preview on first push. `netlify-staged-targets.sh` admits a name only if it matches `^[a-z0-9][a-z0-9-]{0,62}$` and names a real directory (no symlink, no file), and caps the stage at 32 targets; any rejected entry fails the deploy before the Netlify CLI runs. Every target deploys to the `overeng-utils` site under alias `<name>-pr-<n>`, from an empty scratch directory so the Netlify CLI reads no project config from the checkout or the artifact.

## Storybook plays

`storybook-plays.yml` (workflow `Storybook Plays`) executes `test-storybook-plays` only on `merge_group`, with `contents: read` and no secrets. Its PR trigger materializes a skipped check for queue admission. It executes `storybook:test`: for each package marked `playTests = true` in `devenv.nix`, `storybook:test:<name>` runs that package's `vitest.gate.config.ts` with `OVERENG_STORY_GATE_MODE=plays`. Every story tagged `test` renders through Portable Stories in headless Chromium; a failing `play` or accessibility violation fails the lane (`parameters.a11y.test: 'error'`). Plays mode skips settle waits and screenshot comparison, so it needs no pixel baseline. The required job remains a separate workflow only to stay below GitHub Actions' workflow-size limit. With no opted-in package, `storybook:test` is an empty aggregate that succeeds.

Merge-group code may include fork contributions. Pipeline evidence identity and attempt-close jobs mark merge groups untrusted, so queue validation does not gain Tailscale evidence-network admission. Buck cache posture stays explicitly reader-only; protected-main writers and publishers keep their existing event/ref guards.

## Gates and no-op actions

A gate decides whether evidence permits progress. It may be expressed by a failing step/job or by a required check in the ruleset.

A condition that selects whether an action is needed belongs on the step when the surrounding event remains semantically valid. A condition that describes whether an entire lane has an outcome belongs on the job. Event filters are preferred when an event has no meaningful lane outcome at all.

This ordering avoids two failure modes:

1. job-level skipping of a valid no-op action can omit a check needed by the suite; and
2. admitting an irrelevant event and launching a sentinel consumes a runner without producing evidence.

## Measurement cost and cadence

Measurement semantics are specified in [measurements.md](./measurements.md); the reusable comparison boundary is specified in [measurement-engine.md](./measurement-engine.md).

`devenv-perf` retains its probes, runner profile, observation IDs, and artifact contract, but an operator must request it with `workflow_dispatch`. Its wall-clock evidence is advisory and cannot justify automatic pull-request or nightly cost. Targeted Buck2 admission evidence remains recorded with the relevant admission experiment rather than inferred from this whole-repository lane.

The scheduled deterministic lanes remain because their artifacts have stable identities and their trend report is the event's explicit output.

## Generated authority

The editable authorities are:

| Concern                              | Authority                                                                                                                         | Generated output                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| workflow events, jobs, and job gates | `.github/workflows/ci.yml.genie.ts`, `.github/workflows/empirical-proofs.yml.genie.ts`, and shared `genie/ci-workflow.ts` helpers | the corresponding `.yml` files       |
| job inventory and required contexts  | `genie/ci.ts`                                                                                                                     | consumed by workflow/ruleset sources |
| repository required checks           | `.github/repo-settings.json.genie.ts`                                                                                             | `.github/repo-settings.json`         |
| repository labels                    | `.github/labels.json.genie.ts` and shared label catalogs                                                                          | `.github/labels.json`                |

Generated YAML and JSON are checked-in review artifacts, never independent authoring surfaces.

## Plain-flake Rust consumers

`genie/ci-workflow/rust.ts` supplies small step and job builders for Rust repositories
with a plain Nix flake. The helpers are also exported from `genie/ci-workflow.ts` and
`genie/external.ts`; their runtime import graph needs no npm installation.

The consumer devShell includes `effect-utils.packages.${system}.genie`, Rust and
`cargo-nextest`, and creates `repos/effect-utils` as a symlink to the effect-utils
flake input store path. Workflow sources can then import through that symlink:

```ts
import { githubWorkflow, githubWorkflowEvent } from '../../repos/effect-utils/genie/external.ts'
import {
  cargoFmtJob,
  cargoClippyJob,
  cargoNextestJob,
  plainFlakeGenieCheckJob,
  namespaceRunner,
  RUNNER_PROFILES,
  defaultActionlintConfig,
} from '../../repos/effect-utils/genie/ci-workflow.ts'

export default githubWorkflow({
  name: 'Rust CI',
  on: { pull_request: githubWorkflowEvent.all, push: { branches: ['main'] } },
  actionlint: defaultActionlintConfig,
  jobs: {
    fmt: cargoFmtJob(),
    clippy: cargoClippyJob({ extraArgs: ['--', '-D', 'warnings'] }),
    test: cargoNextestJob({
      retries: 2,
      testThreads: 8,
      'timeout-minutes': 30,
      strategy: { matrix: { runner: [...RUNNER_PROFILES] }, 'fail-fast': false },
      runsOn: namespaceRunner({ profile: '${{ matrix.runner }}', runId: '${{ github.run_id }}' }),
    }),
    freshness: plainFlakeGenieCheckJob(),
  },
})
```

Jobs default to the shared Namespace Linux profile with workflow-run affinity.
Runner matrices use the same `namespaceRunner`, `RUNNER_PROFILES` and actionlint
configuration as other CI helpers. Job options retain GitHub's gates, environment,
permissions, defaults, matrix and timeout controls, plus `preSteps`/`postSteps`.

`plainFlakeSetupSteps` installs Determinate Nix and accepts an optional public
`cachix` name for read-only cache access. For custom jobs, compose these setup steps
with `nixDevelopStep({ name, command })`; `command` is an argv vector, not a shell
fragment. An optional `flake` selects a different devShell. The Cargo steps run
`nix develop -c` with fmt checking all crates, clippy using
`--workspace --all-targets --locked`, and nextest using `--workspace --locked`.
Nextest retries default to two; an explicit zero disables retries. Omit
`testThreads` to retain nextest's own concurrency selection.

The freshness job runs `nix develop -c genie --check` and does not prepare a
megarepo, install npm packages, or assume devenv tasks. The focused pure tests run
through `devenv tasks run genie:ci-workflow:test` and are included in `test:run`.

## Traceability

| Requirement area          | Source/evidence                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| event admission           | `.github/workflows/ci.yml.genie.ts`; focused workflow helper tests                                 |
| required checks           | `genie/ci.ts`; `.github/repo-settings.json.genie.ts`; generated-contract test                      |
| dispatch-only performance | `.github/workflows/ci.yml.genie.ts`; `.decisions/0001-event-admission-and-performance-dispatch.md` |
| measurement semantics     | `measurements.md`; `measurement-engine.md`; `.experiments/0001-bencher-evaluation.md`              |
| generated authority       | `AGENTS.md`; `.gitattributes`; the source/output pairs above                                       |
