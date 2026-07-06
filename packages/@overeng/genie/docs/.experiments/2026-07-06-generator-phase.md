# Experiment: generator-phase run-context evidence (2026-07-06)

Load-bearing evidence for decision 0004 (generator phase + `genie:prepare`-before-install). Gathered
while resolving how to reach a zero-baseline bootstrap-closure contract.

## `genie:run` is post-install; the pre-install path is not exercised

- Every genie task in `devenv.nix` is wired `after = ["pnpm:install"]` (`genie:run`, `genie:watch`,
  `genie:check`, `lint:check:genie`, `mr:*`). So `genie:run` runs **post-install** — `effect` resolves and
  every generator (including weaver) succeeds. Nothing fails today.
- The weaver semconv generators (`genie/weaver-registry/*.genie.ts`) render during the _normal_ glob-driven
  `genie:run`, not a separate task. `weaver:check` only _validates_ the already-emitted registry.
- No CI job runs genie pre-install (fresh-clone bootstrap). `pnpm-install-contract` verifies install works,
  not "genie runs before install." So `genie:check` in CI confirms output _correctness_ (post-install), never
  a generator's _bootstrap-safety_.
- Conclusion: the pre-install requirement (R05) protects a _capability_; the static bootstrap-closure gate
  (0003) is the only thing enforcing it, and only for the generators it is scoped to.

## The residual is a phase, not debt

After narrowing the ci-tools wide barrel and the genie-node/typescript leak (Option A, commit `d3042b595`),
the baseline collapsed 79 → 5, and the residual 5 were exactly the weaver generators, all reaching
`effect` through `@overeng/otel-contract/registry` — which is Effect-Schema by design
(`import { Schema } from 'effect'`, "LAYER 2 — opinionated Effect-Schema authoring"). These are genuinely
`effect`-dependent and legitimately post-install: a `design-time` phase, not accepted debt.

## Why completeness can't be static without hardcoding

To check "is the bootstrap-marked set complete?" one needs a ground truth for "which generators must run
pre-install." The only non-hardcoded ground truths are (a) install itself (what it consumes) or (b) the task
dependency graph (what is ordered before install). A static check would have to hardcode install-input
filenames (`package.json`, `pnpm-workspace.yaml`), which the owner rejected. → the enforcement must be the
real ordering (decision 0004: install is the arbiter), with the static gate retained only as fast feedback.
