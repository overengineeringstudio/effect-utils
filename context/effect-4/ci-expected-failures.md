# CI expected-failure manifest — Effect 4 integration branch

Decision **D1** for #925. This file is the gate for the intentionally-red integration branch.

## The gate

**CI must run on every push, and the failure set must equal this manifest.**

Two conditions break it, and the second is the one this file exists for:

1. a failure appears that is not listed here, or a listed failure starts passing without this file
   being updated;
2. **CI does not run at all.**

Condition 2 is not hypothetical. This branch went **16 commits with no CI whatsoever** because it had
become unmergeable against `main`, which silently suppresses `pull_request` workflows. Nobody noticed,
because the branch was documented as "intentionally red" and slice PRs as "not judgeable by repo CI" —
so *"CI is not running"* and *"CI is red, as expected"* were indistinguishable. A gate that cannot
distinguish **"did not run"** from **"ran and failed"** protects nothing.

## Baseline

| | |
|---|---|
| run | **`30548813585`** |
| commit | **`7ef722c3b`** |
| result | 15 failure · 8 success · 2 skipped |
| comparison base | **`main` @ `5f3c78a9f`, run `30461270774` — 25/25 SUCCESS** |

**`main` is fully green, so there is no base noise to subtract and every failure below is
flip-attributable.** This matters for interpreting the manifest later: "expected" here means
*"caused by the migration and understood"*, never *"we gave up on it"*.

Do not repeat the epic body's phrase *"the base fails independently on `test-live-deploy-ci-tools`,
`pnpm-builder-contract`, `test-integration-restate` and the FOD checks"* without qualification. It
refers to the **flip base**, not `main`; all four are green on `main`. Read as "main is red", it would
license discarding genuine failures as pre-existing.

## Green — and two of these are load-bearing

```
bootstrap-cold-proof      bundle-smoke     cargo               default-ref-policy
deploy-storybooks         source-shape
nix-fod-check (namespace-profile-linux-x86-64)
nix-fod-check (namespace-profile-macos-arm64)
```

- **`nix-fod-check` green on both legs** is real evidence the eight-attr FOD refresh on this branch is
  correct. That was the expensive open risk.
- **`bootstrap-cold-proof` green** means the genie bootstrap closure still realizes — the deadlock that
  bridge B8 exists to hold open has not regressed.

## Expected failures — attributed

Cause is the flip: ~52% of the Effect surface is still unported, so anything compiling, linting,
building or testing the workspace fails.

| job | attribution |
|---|---|
| `typecheck` | unported packages; the measured scope was 6,345 de-duplicated TS errors |
| `lint` | unported source |
| `test (namespace-profile-linux-x86-64)` | unported packages fail to compile/collect |
| `test (namespace-profile-macos-arm64)` | as above |
| `nix-check (namespace-profile-linux-x86-64)` | builds packages from source that does not compile |
| `nix-check (namespace-profile-macos-arm64)` | as above |
| `pnpm-builder-contract` | workspace build of unported packages |
| `pnpm-regression` | as above |
| `test-live-deploy-ci-tools` | `ci-tools` unported; this is the package bridge **B8** pins pre-flip |
| `test-megarepo-cold-gc` | `megarepo` unported (largest slice, 1,388 → 550 errors on its branch) |
| `test-integration-notion` | Notion chain unported (228 Effect files) — confirmed green on `main`, so flip-induced |
| `test-integration-restate` | **designed to fail at the flip.** Baseline #985 pins the v3 parser text inside Restate's HTTP 400 body; v4's `SchemaError(...)` changes it. Mitigation tracked in #978. Do **not** rebaseline. |
| `weaver` | **`TypeError: Schema.decodeUnknown is not a function`** — a removed v4 API. See finding below. |

### Finding: `weaver` is an unscoped port gap

`weaver` fails on `Schema.decodeUnknown`, removed in Effect 4. This lane is **not in any wave list**
in #925 — the wave plan enumerates `packages/@overeng/*`, and this is repo tooling. The failure is
real, not infrastructure: CI reports *"failed after 103 s without a detected transient Nix failure"*,
which is the repo's own real-vs-flake discriminator.

**Action: add the weaver lane to the Phase 4 scope.** It is small, but it is currently invisible to
the plan, and an invisible item does not get done.

## UNEXAMINED — must be triaged before they count as expected

These failed and have **not** been root-caused. They are recorded so they are not silently absorbed.

- `nix-closure-sizes`
- `devenv-perf`

**An unexamined entry is indistinguishable from a known one once it is written down.** Both are
plausibly flip-attributable (closure sizes shift when a whole dependency cohort moves; perf lanes
build the workspace), but *plausible* is not *attributed*. Neither may be treated as expected until
triaged, and either could be masking a real regression.

- [ ] triage `nix-closure-sizes`
- [ ] triage `devenv-perf`

## Skipped, not failures

`ci/measurements-report`, `notify-alignment` — conditional jobs.

## What this manifest does NOT establish

**It does not verify the seven already-landed packages** (`effect-path`, `tui-react`,
`content-address`, `kdl`, `kdl-effect`, `effect-distributed-lock`, `otel-contract`). Those landed by
cherry-pick with no CI at all, and this run does not close that:

- `test:<pkg>` pulls a dependency batch that can fail **before reaching** the package under test —
  the normal case while half the graph is unported;
- a red aggregate check says nothing about whether a given package's tests actually **ran**.

Closing it requires per-package runs:

```sh
CI=1 devenv tasks run test:<pkg> --mode single --show-output --no-tui
jq -r '.adapter.records[] | select(._tag=="Metric") | "\(.name)=\(.value)"' <summary.json>
```

Read counts from `adapter.records` — there is **no** top-level `vitest.tests`, and a top-level lookup
returns `null`, which reads as "no data" and is one step from being reported as zero. Also read
`child.exit_code` (distinct from the task runner's) and `degraded`.

**A suite collecting zero tests exits 0 and replays GREEN.** Per #1023 that does not weaken a gate, it
removes it — indistinguishable from passing. Any per-package verification must assert a **non-zero
collected count**.

## Maintenance

Update this file in the **same commit** as any change to the failure set, with the reason. As slices
land, entries move from failing to green and are deleted here — **the manifest shrinking is the
progress metric.** When it is empty, the branch is green and D1 is satisfied.
