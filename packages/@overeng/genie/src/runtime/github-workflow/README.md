# github-workflow

Generate GitHub Actions workflow YAML files with full type safety.

## Usage

```ts
import { githubWorkflow } from '@overeng/genie/lib'

export default githubWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { branches: ['main'] },
  },
  jobs: {
    test: {
      'runs-on': 'ubuntu-latest',
      steps: [
        {
          $comment: 'v4.4.0',
          uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
        },
        { run: 'npm test' },
      ],
    },
  },
})
```

External action steps use full commit SHAs; `$comment` records the matching release
tag as a YAML comment before the step. Consumers of the shared CI helpers must
regenerate their workflows with `devenv tasks run genie:run` after updating their
`published` ref. Action literals authored in a consumer's own workflow sources are
independent of the helpers and must be pinned there as well.

## Features

- **Type-safe**: All workflow fields, triggers, and job configurations are fully typed
- **Complete coverage**: Supports all GitHub Actions workflow syntax including:
  - All event triggers (push, pull_request, schedule, workflow_dispatch, etc.)
  - Job configuration (runs-on, needs, strategy, matrix, etc.)
  - Step types (run steps, uses steps)
  - Permissions, concurrency, environment settings
- **YAML output**: Generates properly formatted YAML

## Validation

`githubWorkflow()` validates each job's `runs-on` value before emitting YAML.

This rejects invalid runner labels such as:

- empty `runs-on` arrays
- non-string labels
- empty string labels
- stale placeholder labels like `namespace-features:github.run-id=undefined`

This is mainly intended to catch CI helper API drift early. Without this validation, stale generated workflows can look superficially valid in the repo but only fail later when GitHub tries to load or schedule the workflow.

The Node actionlint runner passes workflow YAML on stdin. For custom self-hosted
runner labels, it writes a private temporary config and removes the entire
directory in `finally` after success or failure, including config-write failures.
Abrupt process termination can bypass `finally`; those leftovers remain subject
to the temporary-directory aging policy rather than process-global signal hooks.
The bootstrap-safe lifecycle regression runs with
`bun test ./scripts/genie-actionlint.integration.test.ts` from the repository root;
it needs no package install or build.

Private binary-cache jobs accept the static fleet runner labels, including
`sh-linux-x64-publish` and `sh-linux-arm64-publish` for dedicated cache publishers and `sh-linux-x64-ai-gateway` for the self-hosted runner with the AI gateway consumer token provisioned.
Each publisher label can be used alone or with the optional `nix` capability label;
unknown labels are rejected.

## Checking hand-written workflows

Non-Genie repositories can invoke
`overengineeringstudio/effect-utils/.github/actions/ci-policy` after checking out
their repository. Pin `uses` to a full, immutable effect-utils commit SHA, not a
branch or tag. Run the job on the fleet's `[sh-linux-x64, nix]` selector and apply
the canonical `sameRepoPullRequestGuard()` expression when admitting non-push
events. The check job is subject to the same policy as every other job.

**Threat model:** This action is defense in depth against accidental policy drift
and environment-based bypass, not a sandbox against a workflow author who
controls the job and can remove the step. Real enforcement requires the policy
check to be a required check and fleet access to be restricted through runner
groups. The action assumes a trusted runner and the pinned action checkout.

The composite action reads `.github/workflows/*.yml` and `*.yaml` from the
checkout, parses them with Bun's built-in YAML parser, and invokes
`validateWorkflowPolicy()` with `fleetWorkflowPolicy()` in enforce mode. It does
not generate workflows or maintain a separate set of policy regexes. Opaque
job-level reusable workflow calls are rejected rather than treating an unchecked
callee as compliant; executable jobs must declare their runner and steps.

Inputs:

- `repository-root`: checkout path, relative to the workspace or absolute;
  defaults to `.`.
- `exceptions-file`: optional JSON file relative to that root, containing an
  `exceptions` array with the shared `WorkflowPolicyException` fields. Workflow
  identities are exact repository-relative paths such as
  `.github/workflows/ci.yml`. Entries must belong to the consumer repository;
  expiry, provenance, forbidden rules, duplicates, and stale entries are checked
  by the shared validator. No effect-utils migration ledger or exceptions are
  inherited.

There are no npm installs or cache/artifact actions. The fleet runner must provide
Nix at `/nix/var/nix/profiles/default/bin/nix` or
`/run/current-system/sw/bin/nix`; an executable on the consumer's `PATH` is never
used. A small Nix expression reads the pinned action's root `flake.lock` and returns
`github:NixOS/nixpkgs/<locked-rev>#bun`, without copying the worktree into the
store or evaluating the consumer's flake. Pinned-source retrieval and normal
signed binary-cache substitution are allowed; local compilation and remote
builders are disabled. No preinstalled Node/Bun or pre-realized closure is assumed.

The composite shell uses an absolute `/usr/bin/env` launcher with a runner-owned
`PATH`, removes `BASH_ENV`/`ENV` before Bash starts, and enables Bash privileged
mode to ignore startup files and exported functions. The step's `env` mapping
clears Linux `LD_PRELOAD`/`LD_LIBRARY_PATH`/`LD_AUDIT` and macOS
`DYLD_INSERT_LIBRARIES`/`DYLD_LIBRARY_PATH`/`DYLD_FRAMEWORK_PATH` before the native
launcher is created. Inputs remain data rather than interpolated shell code.

Both Nix and Bun run through `env -i` with only an isolated temporary `HOME`,
`TMPDIR`, and a runner-owned `PATH`. Consumer `BUN_OPTIONS`, `NODE_OPTIONS`,
`NIX_CONFIG`, `NIX_USER_CONF_FILES`, `NIX_PATH`, and other configuration overrides
are not forwarded. The temporary home also prevents user configuration discovery.
`nix eval --impure` permits reading the action's checked-out lockfile only.
Policy execution and Bun configuration discovery run from the pinned action root,
not the consumer checkout. Scalar boolean/numeric job conditions are normalized
to strings; mappings/sequences and steps without exactly one nonempty `run` or
`uses` string are rejected before the shared policy is invoked. Runner selectors
must be strings, nonempty string arrays, or nonempty mappings containing only
supported `labels` and/or `group` keys with valid values.

For a local check with Bun available:

```sh
bun genie/ci-workflow/check-policy.ts /path/to/checkout owner/repository
```

The entrypoint fixture tests live in
`genie/ci-workflow/check-policy.integration.test.ts` and run through
`genie:ci-workflow:test` in the `quality` (`pr/quality`) CI job's
“Genie projection and CI workflow regression tests” step.

The real-Nix isolation smoke runs in the same Linux `quality` (`pr/quality`) job,
in the separate “CI policy action isolation smoke” step:
`bun test ./genie/ci-workflow/check-policy-action.integration.test.ts`.
It exercises the actual custom-shell launcher and trusted Nix bootstrap with
hostile Bash startup files/exported functions, Bun/Nix options, loader overrides,
and consumer `bash`/`nix` executables. On Linux it builds a tiny constructor-only
shared object using the pinned nixpkgs C compiler, proves the injection works
against an unsanitized launcher, then verifies the real step excludes it.

## Refreshing migration ledgers

`devenv tasks run genie:run` refreshes existing debt without growing the ledger.
It removes resolved rows and can re-key a grandfathered `banned-action` row when
only step content changes. Matching requires the same repository, workflow,
job, rule, step ID (preferred) or name, and action identity excluding the ref.
Unlabelled steps and ambiguous identities cannot be re-keyed. Every old row and
current finding must match one-to-one; all non-key row fields are retained.

`devenv tasks run genie:check` still rejects content changes until the refresh
has been reviewed and committed. New jobs, steps, or actions remain new debt
even during refresh. Ref bumps remain diagnostic-only under the existing ledger
contract. Banned actions remain never-exceptable: this is a
reviewable update to existing migration debt, not an exception mechanism.

## Type Reference

See [GitHub Actions workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions) for detailed documentation on all options.
