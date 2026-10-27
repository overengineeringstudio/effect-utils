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
      steps: [{ uses: 'actions/checkout@v4' }, { run: 'npm test' }],
    },
  },
})
```

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
mode to ignore startup files and exported functions. Inputs remain environment
data rather than interpolated shell code.

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
hostile Bash startup files/exported functions, Bun/Nix options and consumer
`bash`/`nix` executables.

## Type Reference

See [GitHub Actions workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions) for detailed documentation on all options.
