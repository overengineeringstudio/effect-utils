# Live pnpm Experiments

This file records non-normative live pnpm evidence. Normative behavior lives in
[spec.md](./spec.md).

## CI Cache Boundary

Hypothesis:

- CI should cache the pnpm store directory as the primary warm-install
  boundary.

Result:

- Rejected for the measured pnpm 11 + GVS model. Warm installs reused more of
  the hot path when the pnpm home was restored than when only the store
  directory was restored.

Conclusion:

- CI cache policy should describe the full profile hot state instead of
  assuming `store-dir` alone is the reusable boundary.

## Setup/Fan-Out Archive

Hypothesis:

- One setup job can install once, archive the prepared live state, and fan it
  out to sibling jobs more cheaply than each sibling running a warm install.

Result:

- Rejected for the explored self-hosted runner shape. Archive pack and restore
  cost outweighed the warm install savings.

Conclusion:

- Live setup/fan-out must beat the current warm path in integrated benchmarks,
  not only in synthetic copy tests.

## Runner-Local Seed

Hypothesis:

- A runner-local seed of shared package content plus job-local metadata can
  preserve isolation and reduce install time.

Result:

- Rejected in the explored implementation. Synthetic hardlink tests looked
  promising, but integrated install benchmarks were slower than the current
  warm path and exposed pnpm store-version portability issues.

Conclusion:

- Future seed traits need real-workspace benchmarks, parallel stress, and
  pnpm-version portability proof before becoming defaults.

## 2026-07-17: Mixed Effect generations in a shared GVS

Hypothesis:

- Sharing one pnpm GVS across independently locked Effect 3 and Effect 4 roots
  makes TypeScript identity depend on install order.

Method:

- Install an Effect 3 root containing `effect-distributed-lock` and an Effect 4
  root into one pnpm 11.3 GVS in both orders.
- Compare that with profile-isolated GVS stores and workspace-local `.pnpm`
  stores, all reusing the same content-addressed package bytes where applicable.
- Typecheck the Effect 3 consumer and inspect the dependency edge selected for
  `effect-distributed-lock`.
- Reproduce the downstream repair algorithm separately by inserting a nested
  `effect` link selected only by package name.
- Install `react-redux@9.2.0` against React 18 and React 19 in the shared store,
  reverse install order, and inspect the same-version package instances selected
  for the two peer contexts.
- Remove a selected GVS edge and compare `pnpm install --force` with full
  package-manager-owned projection discard and rematerialization.
- Compare a declared `packageExtensions` edge with an undeclared edge and a
  manually synthesized link.
- Repeat the decisive case in the dotfiles Vista workspace after removing only
  that repair algorithm, without changing the shared GVS policy.

Result:

- Native shared GVS passed both install orders. pnpm kept
  `effect-distributed-lock` linked to Effect 3.21.4 and TypeScript exited zero.
- Profile-isolated GVS and workspace-local `.pnpm` also passed, but added
  separate topology materialization without improving correctness in this case.
- The package-name-only repair selected Effect 4.0.0-beta.97 and inserted it as
  a higher-precedence nested link. The same TypeScript program then failed with
  Effect 3 versus Effect 4 API and identity errors.
- pnpm created distinct `react-redux@9.2.0` package instances for React 18 and
  React 19 peer contexts and preserved both when install order was reversed. A
  name-only repair redirected both consumers to React 19.
- `pnpm install --force` reused the incomplete GVS instance and did not restore
  its missing edge. Discarding the root `node_modules` projection and GVS
  `links/`, while retaining content-addressed `files/`, then reinstalling
  restored the original Effect 3 edge.
- A declared `packageExtensions` edge was represented in pnpm's lock state and
  resolved successfully. Without that declaration the edge was absent; adding a
  manual symlink made the undeclared import resolve and therefore falsified
  dependency truth.
- In the real downstream workspace, deleting only the repair traversal kept the
  shared GVS install green and restored precise Vista and effect-utils
  typechecks. The linked-repo install completed in 22.2 seconds.

Conclusion:

- Shared GVS was not the cause of this failure. The cause was an out-of-band
  graph resolver that discarded version and peer-graph identity.
- pnpm remains the live dependency-edge authority. Repair discards
  package-manager-owned projections and reinvokes pnpm; it does not invent
  package dependency links.
- Declared compatibility extensions use targeted `packageExtensions`; they do
  not justify generic filesystem graph repair.
- Profile-isolated GVS and local `.pnpm` remain fallback traits that require
  their own measured justification rather than correctness defaults.
