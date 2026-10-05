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
| `pull_request`      | `opened`, `reopened`, `synchronize` | Validate the PR head revision and produce every required check.                       |
| `pull_request`      | `labeled` with `ci:heavy-proofs`    | Run only credential-free empirical proofs for the labeled PR head.                    |
| `push`              | `main`                              | Validate the merged trunk revision and run eligible main-only work.                   |
| `schedule`          | `17 3 * * *`                        | Run empirical proofs, deterministic measurements and the aggregate trend report.      |
| `workflow_dispatch` | explicit operator request           | Run the requested CI/measurement work, including `devenv-perf` and baseline backfill. |

`pull_request:labeled` is admitted only by Empirical Proofs and selects empirical lanes only when the applied label is `ci:heavy-proofs`. Other label events launch no lanes. CI does not admit label events, and proof concurrency is isolated by workflow and event scope, so label churn cannot cancel code checks. A labeled PR also runs empirical proofs on subsequent code pushes. The credentialed remote-cache proof stays in CI on trusted main push/dispatch regardless of labels.

Empirical Proofs emits no ordinary required contexts. Source measurements are partitioned: required `source-shape` runs on PR revisions in CI, while `main/source-shape` runs on main push/nightly/dispatch alongside closure/performance artifacts and the aggregate report. A proof-workflow skip therefore cannot replace failed code evidence.

Source measurement dispatch retains historical backfills on any ref, including nonempty `measurement_baseline_ref`; this credential-free measurement exception does not admit the three empirical proof jobs or credentialed remote proof on non-main dispatches. Report publication remains main-only.

Some control-event workflows admit actions where the requested side effect is validly unnecessary. Those workflows keep the job alive and gate only the conditional step, so GitHub produces a successful check suite rather than an absent required check. The auto-review workflow is the current example: its review-request step is conditional, while the job itself always concludes.

## Lane semantics

A **lane** is one workflow job (or a job matrix) with one declared cadence and outcome.

- Product and source-policy lanes run for admitted PR revisions.
- Main-only lanes run only after changes reach `main` or through an authorized dispatch.
- `bootstrap-cold-proof`, `test-megarepo-cold-gc`, and `nix-closure-sizes` run in Empirical Proofs on trusted main push, nightly, or main dispatch, and on PRs carrying `ci:heavy-proofs`; their PR variants have no writer credentials.
- `devenv-perf` is dispatch-only. It has no pull-request label coupling and does not run on the schedule.
- `ci/measurements-report` aggregates the measurement artifacts produced by the current push, schedule, or dispatch and remains advisory.

The schedule covers empirical cold-bootstrap/cold-GC authority and deterministic trends, not a nightly rerun of product CI. The empirical lanes do not block ordinary PR merges; build-products, frozen-lockfile checks, generated freshness, and ordinary product tests remain merge-blocking.

## Checks and ruleset

GitHub creates a check run for each materialized job and groups runs from one workflow execution in a check suite. Branch protection names required check-run contexts, not source-level job keys.

`genie/ci.ts` is the typed inventory for workflow job keys and required contexts:

- `CORE_CI_JOB_NAMES` and `EXTRA_CI_JOB_NAMES` inventory product, source-policy, and empirical lanes;
- `MAIN_ONLY_CI_JOB_NAMES` contains jobs that do not materialize on pull requests;
- `OPT_IN_CI_JOB_NAMES` contains `devenv-perf`, whose dispatch-only cadence prevents it from being required;
- `advisoryCIJobNames` contains report/notification jobs whose conclusions do not gate merge;
- `REQUIRED_CI_JOB_NAMES` contains the default-ref policy job plus core and extra PR jobs, excluding `EMPIRICAL_PROOF_CI_JOB_NAMES`, opt-in, main-only, and advisory jobs;
- `STANDALONE_REQUIRED_CI_JOB_NAMES` contains merge-blocking jobs of per-PR workflows outside `ci.yml` (currently `test-storybook-plays`); each runs on every pull request with no path filter or job-level `if`;
- `ciJobCheckContexts` expands matrix job keys to the exact runner-qualified context strings emitted by GitHub.

The main-only exclusion is deliberate and fixes the absent-check failure mode: requiring `test-integration-notion`, `test-live-deploy-ci-tools`, or `deploy-storybooks` on a pull request would leave branch protection waiting for check runs that the workflow never creates.

`.github/repo-settings.json.genie.ts` derives the repository ruleset directly from `requiredCIJobs` (the expanded `REQUIRED_CI_JOB_NAMES` plus `STANDALONE_REQUIRED_CI_JOB_NAMES`). Tests compare the generated workflows' eligible check contexts with the generated ruleset, including matrix expansion and the exclusions above.

## Storybook previews

Storybook deploys split by trust. `deploy-storybooks` in the CI workflow is main-only and deploys production with `NETLIFY_AUTH_TOKEN`. PR previews use two workflows outside CI, so preview latency and CI conclusions stay independent:

| Workflow                       | Event                       | Trust                   | Outcome                                                                                                                    |
| ------------------------------ | --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `storybook-preview-build.yml`  | `pull_request`              | PR code, no secrets     | `build-storybooks` runs `netlify:stage` and uploads the static output as the `netlify-preview-static` artifact.            |
| `storybook-preview-deploy.yml` | `workflow_run` of the build | default-branch revision | Resolves the PR from the event payload, deploys the artifact with `netlify:deploy-staged`, and updates the sticky comment. |

The deploy workflow treats the artifact as data: it checks out `github.workflow_sha`, never the PR head, and hands the static files to `netlify deploy --no-build`. PR number and head SHA come from `github.event.workflow_run` and the GitHub API; a closed PR or a head that moved past the triggering run is skipped. Fork PRs are not deployed. `NETLIFY_AUTH_TOKEN` exists only in the deploy step environment, and only `publish-preview-comment` has `pull-requests: write`. Because `workflow_run` workflows run from the default branch, changes to the deploy workflow take effect after they merge.

The deploy target set is the artifact's top-level directory names, not the default branch's Storybook list, so a PR that adds a Storybook package gets its preview on first push. `netlify-staged-targets.sh` admits a name only if it matches `^[a-z0-9][a-z0-9-]{0,62}$` and names a real directory (no symlink, no file), and caps the stage at 32 targets; any rejected entry fails the deploy before the Netlify CLI runs. Every target deploys to the `overeng-utils` site under alias `<name>-pr-<n>`, from an empty scratch directory so the Netlify CLI reads no project config from the checkout or the artifact.

## Storybook plays

`storybook-plays.yml` (workflow `Storybook Plays`) runs its single `test-storybook-plays` job on every pull request and on pushes to `main`, with `contents: read` and no secrets. It executes `storybook:test`: for each package marked `playTests = true` in `devenv.nix`, `storybook:test:<name>` runs that package's `vitest.gate.config.ts` with `OVERENG_STORY_GATE_MODE=plays`. Every story tagged `test` renders through Portable Stories in headless Chromium, and a failing `play` or an accessibility violation fails the lane (`parameters.a11y.test: 'error'`). Plays mode skips the story gate's settle wait and screenshot comparison, so it needs no baseline: pixel captures depend on the host's fonts, so the visual gate stays a same-host local tool. `test-storybook-plays` is a required check, listed in `STANDALONE_REQUIRED_CI_JOB_NAMES`. The workflow is separate from `ci.yml` only so `ci.yml` stays under the GitHub Actions workflow size limit. Because the check is required, the job has no path filter and no job-level `if`: a skipped job reports no check run and would block every pull request. With no opted-in package, `storybook:test` is an empty aggregate that succeeds.

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

## Traceability

| Requirement area          | Source/evidence                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| event admission           | `.github/workflows/ci.yml.genie.ts`; focused workflow helper tests                                 |
| required checks           | `genie/ci.ts`; `.github/repo-settings.json.genie.ts`; generated-contract test                      |
| dispatch-only performance | `.github/workflows/ci.yml.genie.ts`; `.decisions/0001-event-admission-and-performance-dispatch.md` |
| measurement semantics     | `measurements.md`; `measurement-engine.md`; `.experiments/0001-bencher-evaluation.md`              |
| generated authority       | `AGENTS.md`; `.gitattributes`; the source/output pairs above                                       |
