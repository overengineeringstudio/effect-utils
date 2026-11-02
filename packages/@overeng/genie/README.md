# @overeng/genie

TypeScript-based code generator for config files. Define your `package.json`, `tsconfig.json`, `oxlint.jsonc`, `oxfmt.jsonc`, and GitHub workflow files as TypeScript and generate them with consistent formatting.

Architecture and subsystem behavior are documented in the VRS set:

- [docs/vision.md](./docs/vision.md)
- [docs/requirements.md](./docs/requirements.md)
- [docs/spec.md](./docs/spec.md)

## Installation (Nix)

Genie is distributed as a native binary via Nix. **This is the only supported installation method** to avoid chicken-egg problems: since genie generates `package.json` files, it must be available before `pnpm install`.

### In your flake.nix

```nix
{
  inputs = {
    # ... other inputs ...
    genie = {
      url = "path:./path/to/effect-utils/packages/@overeng/genie";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, genie, ... }:
    {
      devShell = pkgs.mkShell {
        buildInputs = [
          genie.packages.${system}.default
        ];
      };
    };
}
```

### In devenv.yaml

```yaml
inputs:
  genie:
    url: path:./packages/@overeng/genie
```

Then in `devenv.nix`:

```nix
{ pkgs, inputs, ... }:
let
  genie = inputs.genie.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  packages = [ genie ];
}
```

### Rebuilding after changes

```bash
# After modifying genie source code
devenv tasks run nix:build:genie

# After repo-root pnpm-lock.yaml changes (updates dependency hash)
refresh Nix FOD hashes for genie with the repo workflow

# Build all CLI packages (optional)
devenv tasks run nix:build
```

## Usage

### CLI (via devenv tasks)

```bash
# Generate all config files
devenv tasks run genie:run

# Check if files are up to date (for CI)
devenv tasks run genie:check

# Watch mode - regenerate on changes
devenv tasks run genie:watch
```

Check mode shares a lazy formatter-config preflight across supported output files within
one invocation. A successful preflight is retained as an invocation-local snapshot;
failures are not memoized, so a later file retries after a config repair. Concurrent
callers share the same in-flight attempt. Each file still uses the same oxfmt CLI and
filepath-specific configuration. The preflight is recreated on the next check; generation
keeps fresh config reads because it may generate the formatter configuration itself.
Dependency-store projections likewise
reuse ordered edges and binary entries only within a single projection computation.

Or use the `genie` binary directly for additional options:

```bash
genie --writeable  # Generate writable files (default is read-only)
genie --dry-run    # Preview changes without writing
```

Generation stores output locks under `$XDG_STATE_HOME/genie/locks`, defaulting to
`~/.local/state/genie/locks` when the variable is unset, empty, or not absolute.
The target path, not discovery cwd, identifies each lock, so running inside a
source root does not add package inputs or split the output-lock namespace.
Buck package source and test censuses also exclude existing `tmp/genie-locks`
state directories. Ordinary files under `tmp` remain inputs, and unsafe paths
or symlinks outside the state are still rejected.

### GitHub workflow fleet policy

`githubWorkflow({ policy, ...workflow })` validates policy at construction,
serialization, and validation. `policy` is generator metadata and is never
emitted into YAML. The generic validator is in
`src/runtime/github-workflow/policy.ts`; fleet values are shared once in
`genie/ci-workflow/policy.ts`, with runner labels and platforms in
`genie/ci-workflow/runners.ts`. `ciWorkflow`, `autoReviewWorkflow`, and
`releaseWorkflow` enforce the fleet policy by default.

Policy rejects hosted, Namespace, unknown, unresolved dynamic, fallback, and
mixed-heavy runner selections; forbidden events; Actions artifact/cache
actions and known wrappers; setup-action caching; and Docker `type=gha`.
Finite runner matrices are resolved before admission. Dynamic runner outputs
require an exact typed admission declaration with admitted possible labels.
`linuxX64Runner` selects light work; `linuxX64HeavyRunner` is the dedicated
heavy scale set and must never be combined with generic labels.

Jobs that could reach fleet runners (including capability-only labels, unknown
selectors, and runner groups) require `sameRepoPullRequestGuard()` whenever any
workflow trigger is outside `push`, `merge_group`, `schedule`, or
`workflow_dispatch`. This default-deny rule includes future events and reusable
workflows, which inherit their caller's event. The exact guard, alone or as a
top-level conjunction, permits only
push, merge groups, schedules, manual dispatches, and repository-owned PR or
upstream-run heads. Unknown events, issue comments, and pull-request targets
are not admitted. OR, negated, and partial guards are rejected.
Fork-controlled runner expressions are hard errors even with a guard.
Immutable hosted/Namespace selector prefixes prove non-fleet routing even
when their feature suffixes contain expressions.
Expression scanning respects quoted braces and doubled single-quote escapes,
so format strings cannot hide fork-controlled runner inputs.
For untrusted workflow triggers, case-insensitive context token admission permits
only `matrix.*`, `vars.*`, exact typed `needs.<job>.outputs.*` contracts, and
`github.repository`, `repository_owner`, `run_id`, `run_number`, `run_attempt`,
and `workflow`. Repository identity and checked-in workflow names are not PR
payload; run identifiers/counters are assigned by GitHub. Bare context roots,
index access, caller inputs, environment/step outputs, and unknown functions
are rejected. Known pure expression functions do not relax argument admission.
`matrix.*` admission follows the referenced axis/include values and all
include/exclude modifiers. Static rows must provide the referenced key/path;
dynamic matrix, axis, or row expressions must themselves pass the same token
policy using only configuration, immutable identity, or exact admitted outputs.
Missing keys and event/input/environment/step-derived sources are hard
`fork-controlled-runner` failures, even with a matching report ledger.
Trusted dynamic sources still require ordinary dynamic-runner admission.
`ciWorkflow` requires consumers to supply the guard explicitly; higher-level
auto-review and release helpers add it when selecting fleet runners.
Neither exceptions nor the report ledger can admit an unguarded potential
fleet job, fork-controlled runner selection, or `pull_request_target`.
Cache-publisher validation recognizes that exact canonical guard as a narrowing
top-level conjunction (in either order) and analyzes the remaining main-branch
and trusted-event restriction. Modified guards or outer disjunctions are not
stripped, and a remaining restriction permitting PR publication still fails.
Publisher event scope is proved only by an entire positive top-level event
conjunct (`github.event_name == 'push'`, or a parenthesized OR of such comparisons).
Multiple positive event conjuncts intersect their event sets. Negations,
inequalities, function calls, and other predicates are opaque narrowings: they
cannot establish event scope. Without a positive event proof, publication fails.
Condition boundaries respect quoted strings and balanced parentheses/brackets;
operators inside index expressions cannot prove a guard, main ref, or event scope.
Unbalanced or mismatched delimiters fail closed.
This generator boundary assumes ephemeral runners, no persistent secrets, and
repository-restricted runner groups; it does not verify infrastructure settings.

Runner selection is explicit: `prReviewsResolvedJob`, `prSnapshotPackJob`,
`prSnapshotReleaseJobs`, `plainFlakeJob` and its Cargo/genie wrappers require
`runsOn: linuxX64Runner` (or another appropriate export from `runners.ts`).
`pipelineCloseJob({ jobs, runsOn: linuxX64Runner })` requires explicit runner selection.
`releaseWorkflow` requires
`runsOn: { createReleasePr: linuxX64Runner, validateReleasePlan: linuxX64Runner, publishRelease: linuxX64Runner }`.

The central `policy-exceptions.json` requires exact repository, workflow,
job, and rule plus owner, approver, justification, expiry, and tracking issue.
Each workflow receives only its own repository/workflow entries. The complete
repository census uses `validateFleetPolicyExceptionRegistry` to reject stale
or unmatched entries; the own-workflow ledger generator runs that census.
Setup-action cache controls follow their cited upstream manifests: Go caches
by default, Python/Java/.NET require explicit caching, Node v5+ requires
`package-manager-cache: false` plus no explicit cache, and Bun requires
`no-cache: true`. Only exact `vN`, `vN.N`, or `vN.N.N` Node tags can select
the pre-v5 contract; every other ref is conservatively treated as modern.
Hosted runners, Namespace, storage, fallback, mixed-heavy, `pull_request_target`,
and same-repository guard rules cannot be excepted.
This repository explicitly uses report mode with the generated
`policy-migration-ledger.json`: new violations fail eagerly, while removed debt
is omitted automatically by regeneration (`genie:run`). The ledger is migration
inventory, not an exception mechanism; it only shrinks and must eventually be
empty. `genie --check`/CI rejects stale committed rows through the generated-file
freshness diff until the shrunk ledger is committed. No hand edits are needed,
and generation cannot admit new rows or security violations.
Ledger generation and report checks share the same validated,
exception-filtered observations. The raw census is retained only to detect
stale exceptions, so accepted exceptions cannot reappear on regeneration.
Storage ledger paths label steps by ID or name while always including ref-free
action repository/subpath and canonical execution/input content. Only equivalent
steps share an occurrence ordinal; absolute step indexes are never used.
Removing a same-name step with different content cannot manufacture new debt,
and changing an action cannot inherit an unrelated action's existing ledger row.
For banned actions, the observed ref remains diagnostic metadata in `value`,
but ledger matching excludes it. Ref bumps do not introduce new debt, and
equivalent-step ordinals use the same ref-insensitive identity.

#### Consumer migration ledgers

Consumers repinning shared CI helpers can inventory existing storage debt without
disabling policy. `consumerMigrationPolicy` and `consumerMigrationLedger` are
exported from `genie/ci-workflow.ts` and `genie/ci-workflow/policy.ts`.
The policy helper uses report mode, decodes the existing `{ violations: [...] }`
JSON shape, and selects only rows for the supplied workflow identity. Existing
hand-rolled `fleetWorkflowPolicy({ mode: 'report', ledger })` policies still work.
New violations fail; `pull-request-target`, `fleet-pr-without-same-repo-guard`,
and `fork-controlled-runner` can never be ledgered, including during seeding.
The pnpm-state helpers are unchanged.

Keep raw workflow definitions separate from eager generation so the initial
inventory does not need to import a workflow that already fails enforcement.
For example, export `ciDefinition` (a `GitHubWorkflowArgs`) from
`genie/ci-definition.ts`, then create the initial JSON once:

```ts
// genie/seed-policy-ledger.ts (one-time script; remove after seeding)
import { writeFileSync } from 'node:fs'
import { consumerMigrationLedger } from '../repos/effect-utils/genie/ci-workflow.ts'
import { ciDefinition } from './ci-definition.ts'

const data = consumerMigrationLedger({
  workflows: { 'ci.yml': ciDefinition },
})
writeFileSync('genie/policy-migration-ledger.json', JSON.stringify(data, undefined, 2) + '\n', {
  flag: 'wx',
})
```

Run `bun genie/seed-policy-ledger.ts`. Include every workflow in this initial
census, review the JSON, then delete the seed script: seeding is not the refresh
command. Exclusive creation (`flag: 'wx'`) refuses to overwrite an existing ledger
if the script is accidentally rerun. Do not reseed to accept new debt.
The default repository identity is
the literal `${{ github.repository }}`, matching `ciWorkflow`; if you supply an
explicit repository, use the same value for seed, policy, and refresh. Workflow
keys must likewise match exactly.

Apply the ledger in `.github/workflows/ci.yml.genie.ts`:

```ts
import { ciWorkflow, consumerMigrationPolicy } from '../../repos/effect-utils/genie/ci-workflow.ts'
import { ciDefinition } from '../../genie/ci-definition.ts'
import ledger from '../../genie/policy-migration-ledger.json' with { type: 'json' }

export default ciWorkflow({
  ...ciDefinition,
  policy: consumerMigrationPolicy({ workflow: 'ci.yml', ledger }),
})
```

For permanent shrink-only refresh, add
`genie/policy-migration-ledger.json.genie.ts`, reusing the ordinary genie
generated-file machinery (adjust dependency paths for your checkout):

```ts
import ci from '../.github/workflows/ci.yml.genie.ts'
import { consumerMigrationLedger } from '../repos/effect-utils/genie/ci-workflow.ts'
import { createGenieOutput } from '../repos/effect-utils/packages/@overeng/genie/src/runtime/core.ts'
import ledger from './policy-migration-ledger.json' with { type: 'json' }

const data = consumerMigrationLedger({
  workflows: { 'ci.yml': ci.data },
  ledger,
})
export default createGenieOutput({
  data,
  stringify: () => JSON.stringify(data, undefined, 2) + '\n',
})
```

Run `genie` (or the consumer's `devenv tasks run genie:run`) to remove resolved
rows automatically, and `genie --check` in CI to reject stale committed JSON.
Include all workflow outputs in the refresh census. Eager workflow imports and
the refresh helper both reject new debt before writing a ledger. Step identities
and ref matching are the same as the fleet policy's existing ledger format.
Once the inventory is empty, remove the migration ledger and explicit policy to
return to `ciWorkflow`'s default enforcement.

Shared-helper tests enforce runner/event policy. Storage-emitting helpers are
explicitly listed as `pendingStorageMigration` in
`genie/ci-workflow/policy.unit.test.ts` until stage L7; their storage behavior
is intentionally unchanged and own-workflow uses remain in the ledger.

#### Cold pnpm state in consumer jobs

The shared pnpm Actions-cache APIs are removed: `restorePnpmStateStep`,
`savePnpmStateStep`, `pnpmStatePublisherPostSteps`,
`withSinglePnpmStatePublisher`, `pnpmStateCacheVersion`,
`defaultPnpmStateKeyPrefix`, and `ciPnpmStatePaths`. pnpm state is a disposable
accelerator, not an Actions-cache handoff.

Delete restore/save steps, publisher wrappers, and their imports from consumer
workflows. Remove `restorePnpmState` options passed to
`standardSelfHostedPnpmCiPrepSteps`, and `savePnpmState` /
`savePnpmStateOptions` passed to `standardSelfHostedPnpmCiPostSteps`
(including nested `prep` / `post` options of
`standardSelfHostedDevenvTaskJob`). Refresh the migration ledger to drop the
matching removed-action rows; refresh only shrinks the existing inventory.

Keep `pnpmStateSetupStep` when composing jobs manually: it creates the
job-local pnpm store/home, links the workspace store, and exports their paths.
Run `pnpm:install` unconditionally after setup. The standard preparation helper
retains setup and `pnpmInstallWithDiagnosticsStep()` without consulting a cache
hit or requiring a restored snapshot. Nix cache helpers are unchanged.

### Creating a Generator

Create a `.genie.ts` file next to the config file you want to generate:

```ts
// package.json.genie.ts
import { packageJSON } from '@overeng/genie/lib'

export default packageJSON({
  name: '@myorg/my-package',
  version: '1.0.0',
  type: 'module',
  exports: {
    '.': './src/mod.ts',
  },
  dependencies: {
    effect: '^3.12.0',
  },
})
```

Run `devenv tasks run genie:run` to generate `package.json` from the source file.

### GitHub repository settings

Generate `.github/repo-settings.json` from one typed source:

```ts
import { githubRepoSettings, githubRuleset } from '@overeng/genie'

export default githubRepoSettings({
  repository: {
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    allow_update_branch: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    squash_merge_commit_title: 'PR_TITLE',
  },
  rulesets: [
    githubRuleset({
      name: 'protect-main',
      enforcement: 'active',
      rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
    }),
  ],
})
```

Plain-flake consumers do not need devenv:

```bash
# Read-only diff; exits non-zero when repository fields or rulesets drift.
nix run github:overengineeringstudio/effect-utils#gh-check-settings -- \
  --repo owner/name --file .github/repo-settings.json

# PATCH explicitly declared repository fields; create/update rulesets by name.
nix run github:overengineeringstudio/effect-utils#gh-apply-settings -- \
  --repo owner/name --file .github/repo-settings.json
```

The apps package `gh` and use its existing authentication (`gh auth login` or
`GH_TOKEN`). Omitted repository fields and unrelated rulesets are unmanaged.
Rulesets inherited from an organization are not modified. Duplicate desired
ruleset names are rejected before any write. Applying several GitHub API
updates is not transactional: an API failure may leave earlier updates applied;
rerunning apply reconciles the remaining drift.

Within each managed ruleset, rule presence is exact and rule order is ignored.
Rules are matched by `type`; only declared parameter keys are compared, recursively
for nested objects. Parameter arrays (including required status-check entries) remain
exact. Live-only parameters do not cause drift. Updates preserve those unmanaged
parameters on retained rule types before sending the rules array to GitHub's
[ruleset PUT endpoint](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset),
while declared values, arrays and rule presence remain authoritative.

The `devenvModules.tasks.github-ruleset` module exposes the same
`gh:apply-settings` / `gh:check-settings` operations as thin wrappers,
configured with `{ repo = "owner/name"; }`. Its legacy `ruleset` parameter
remains optional and asserts the expected name. Historical JSON files containing
one raw `githubRuleset` payload remain supported; those files control only that
ruleset and do not change repository settings.

Existing raw-ruleset consumers can adopt the envelope to manage repository merge
settings. Their current payloads do not require an immediate migration.
Effect-utils itself retains its raw ruleset payload, including its merge queue
and required CI checks; enabling repository-field management is a separate policy change.

The authoring builder and comparison utilities in `src/runtime/github-repo-settings`
are dependency-free. The Effect CLI, schemas and reconciliation engine live in
`src/build/github-repo-settings`; reconciliation remains exported through
`@overeng/genie/node`. Authoring exports stay available from `@overeng/genie` and
the peer `genie/external.ts` facade without importing the engine.

## Generators

Each generator has its own documentation:

- **[package-json](./src/lib/package-json/README.md)** - Generate `package.json` files with field ordering, dependency inference, and validation
- **[tsconfig-json](./src/lib/tsconfig-json/README.md)** - Generate `tsconfig.json` files with TypeScript compiler options
- **[github-workflow](./src/lib/github-workflow/README.md)** - Generate GitHub Actions workflow YAML files
- **[github-action](./src/runtime/github-action/README.md)** - Generate GitHub Action metadata (`action.yml`) files
- **[oxlint-config](./src/lib/oxlint-config/README.md)** - Generate `oxlint.jsonc` configuration files
- **[oxfmt-config](./src/lib/oxfmt-config/README.md)** - Generate `oxfmt.jsonc` configuration files
- **[pnpm-workspace](./src/lib/pnpm-workspace/README.md)** - Generate `pnpm-workspace.yaml` files

### Repository rulesets

`githubRuleset()` builds one repository ruleset payload per generated JSON file.
Bypass actors include individual GitHub `User` IDs, alongside apps, teams and
repository roles.

The `@overeng/genie/node` entry exports `reconcileGithubRuleset({ mode, options })`,
where `options` contains `repo`, the declared `ruleset` name and its generated
`file`. `check` reports missing rulesets and controlled-field drift without
writing; `apply` creates a missing ruleset or updates its existing ID.
For multiple rulesets, await reconciliation sequentially in the intended policy
order. For a policy split, create the replacement ruleset before removing those
rules from the existing ruleset.

## Composition Helpers

The canonical `@overeng/genie` export exposes the thin artifact builders. Use
`@overeng/genie/composition` for reusable cross-artifact helpers that consume
structured generator metadata explicitly.

```ts
import { tsconfigJson } from '@overeng/genie'
import { tsconfigReferencesFromPackages } from '@overeng/genie/composition'

import appPkg from './package.json.genie.ts'

export default tsconfigJson({
  compilerOptions: { composite: true },
  references: tsconfigReferencesFromPackages({ from: appPkg }),
})
```

## Features

- **Read-only output** - Generated files are marked read-only by default to prevent accidental edits
- **Header comments** - Adds source file references where supported; strict JSON files, including `.watchmanconfig`, remain comment-free
- **Formatting** - Automatically formats JSON/YAML output via oxfmt. Formatter stdin remains owned until the subprocess and its streams close, so an early formatter exit falls back to the original content without an unhandled pipe error.
- **Check mode** - Verify files are up to date in CI without regenerating
- **Watch mode** - Auto-regenerate on source file changes

## Shared Constants

For monorepos, define shared constants in a central file:

```ts
// genie/repo.ts
export const catalog = {
  effect: '3.12.0',
  '@effect/platform': '0.90.0',
  // ...
}

export const workspacePackagePatterns = ['@myorg/*'] as const
```

Then import in your `.genie.ts` files:

```ts
import { packageJsonWithContext } from '@overeng/genie/lib'
import { catalog, workspacePackagePatterns } from '../genie/repo.ts'

export default packageJsonWithContext({
  config: {
    name: '@myorg/my-package',
    dependencies: ['effect'],
  },
  context: { catalog, workspacePackages: workspacePackagePatterns },
})
```
