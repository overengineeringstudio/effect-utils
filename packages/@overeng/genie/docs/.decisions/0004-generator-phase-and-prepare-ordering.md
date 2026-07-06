# Decision 0004: Generator phase + `genie:prepare`-before-install makes bootstrap-safety structurally enforced

## Status

Accepted

## Context

The bootstrap-closure gate (decision 0003) enforces that a `.genie.ts` and its transitive runtime
closure are importable before install. But not every generator needs to run pre-install: the OTel
semconv (weaver) generators are Effect-Schema by design and genuinely need `effect`. Applying the gate
to _all_ generators forced a 79-entry baseline whose residual (after narrowing the ci-tools barrel) was
exactly the 5 weaver generators — a "post-install-class" generator masquerading as accepted debt.

Investigation established the load-bearing facts:

- In effect-utils every genie task is wired `after = ["pnpm:install"]`; `genie:run` runs **post-install**,
  so `effect` is available and nothing fails today. The pre-install requirement (R05) protects a _capability_
  (regenerating install inputs before install), not the steady-state flow.
- CI never exercises the pre-install path, so a generator's bootstrap-safety is **not** validated by
  `genie:run`/`genie:check`; the static gate is the only enforcement.
- Whether a generator is "bootstrap-critical" cannot be decided statically without hardcoding a list of
  install-input filenames (`package.json`, `pnpm-workspace.yaml`, …). The only non-hardcoded ground
  truths are (a) install itself (what it consumes) or (b) the task dependency graph (what is ordered
  before install).

## Decision

Introduce a **generator phase** and make bootstrap-safety enforced by **real ordering**, not a static proxy.

- **Phase is a per-generator property.** `design-time` is the DEFAULT (unmarked). `bootstrap` is OPT-IN
  via a **static source pragma** in the `.genie.ts` (readable without importing the generator — importing a
  design-time generator would itself need `effect`).
- **Ordering is the enforcement.** Bootstrap generators run in **`genie:prepare`, before `pnpm:install`**;
  `pnpm:install` depends on `genie:prepare`. Design-time generators run in the normal post-install `genie:run`.
- **Install is the arbiter.** A generator whose output install needs but that is left unmarked does not run
  in `genie:prepare`, so install sees a stale/missing input and fails — no hardcoded "install input" list;
  install decides. A `bootstrap` generator that reaches a runtime-only package runs in the real
  pre-install environment (no `node_modules`) and fails there.
- **The static bootstrap-closure gate (0003) is retained as fast local feedback**, scoped to the
  bootstrap-marked generators (it reads the pragma statically, checks only those closures, zero tolerance).
  It is a quick pre-check for the empirical truth that `genie:prepare` establishes, not the source of truth.
- **The baseline is deleted.** Weaver generators are `design-time` → structurally out of scope. No baseline,
  no allowlist, no enumerated exceptions.

## Options considered

- **Scope derived from install-input filenames (Q1-A).** Rejected: hardcodes a convention the owner
  explicitly rejected; can't express a pre-install need that isn't an install input.
- **Declared phase, opt-OUT of a bootstrap default with required reason (Q2).** Superseded by opt-IN:
  the bootstrap-critical set is small; marking the few is less overhead than annotating the ~80 design-time
  generators, and it makes the pre-install contract a small explicit positive set.
- **Static completeness check (glob install-input generators, assert each is marked — the 0005
  no-orphan-seam pattern).** Rejected: still hardcodes "which outputs are install inputs." A static check
  cannot know what install needs.
- **Empirical CI spot-check (P2):** run marked generators in a fresh sandbox + install, in a dedicated CI
  job. Rejected as primary: principled but a separate test that can drift from the real flow.
- **Structural ordering (P1, chosen):** the pre-install run IS the real dependency order, exercised on every
  run; install enforces completeness and execution enforces safety, with nothing to hardcode.

## Consequences

- Genie gains a phase-selection capability (`genie:prepare` runs only `bootstrap`-marked generators);
  the devenv task graph is reordered so `pnpm:install` depends on `genie:prepare`.
- Bootstrap-safety becomes _structurally true_ (a violation breaks the real bootstrap), not asserted by a
  proxy. The static gate remains for fast feedback.
- No baseline file, no allowlist. The residual weaver generators are `design-time` by declaration.
- Residual risk (accepted): the phase pragma is "just a string"; a _wrong_ mark is caught by install (a
  bootstrap generator that can't run pre-install fails; an unmarked install-input generator fails install),
  not by a static rule — which is the point (install, not a convention, is the authority).

## Implementation notes (as built)

- **Phase pragma.** Declared as a `// @genie-phase bootstrap` line comment, read from raw source text
  (`src/core/phase.ts`, `parseGeneratorPhase`) — no import, no TS parse. `design-time` is the default.
  The bootstrap set is the 35 `package.json.genie.ts` + `pnpm-workspace.yaml.genie.ts` (36 marks). A
  per-file pragma (not a `package.json.genie.ts` filename rule) is used precisely because R32 forbids a
  hardcoded install-input catalog.
- **Task name is `genie:bootstrap`, not `genie:prepare`.** The shared `genie.nix` `genie:prepare` is a
  prerequisite hook that `genie:run`/`genie:check`/`genie:watch` depend on. The pre-install runner is a
  separate effect-utils-local task `genie:bootstrap` (`genie --phase bootstrap`), with `pnpm:install`
  depending on it, because (a) it stays repository-local and does not mutate the exported shared module,
  and (b) it adds no direct writing edge to `genie:run`/`genie:watch`. Note it does NOT keep the writer
  out of `genie:check`'s dependency chain: `genie:check → pnpm:install → genie:bootstrap`, so the writer
  is transitively upstream of `genie:check` regardless of the task name. Masking is prevented by the
  cold-guard, not by the separation. Purely additive and revertible.
- **Install-path blast radius.** `pnpm:install` is the most-depended-on task in the graph; it now depends
  on `genie:bootstrap`, which runs a full `genie --phase bootstrap` generate + validation over the 35
  `package.json` (including strict tsgo export proofs where configured). This adds cost to every warm
  install and a new failure mode — a genie generation/validation flake now fails `pnpm:install` and
  cascades downstream. The cold-guard keeps this off the fresh-clone path; the surface is the
  warm/steady-state case. This is the headline operational risk of the reorder.
- **Two enforcement gaps observed and accepted (the honest result).** In this committed-output,
  source-mode repo, "install is the arbiter via real ordering" holds only partially:
  1. _Source-mode genie can't run cold._ `genie` on `PATH` needs `node_modules`; `genie:bootstrap` is
     guarded to no-op when `node_modules` is absent, so a fresh clone relies on committed outputs, not on
     this task's execution. The `bootstrap-closure:check` static gate carries the pre-install safety
     property — though it too imports `typescript`, so it is fast local feedback, not a `node_modules`-free
     proof.
  2. _Committed outputs blunt completeness._ A forgotten bootstrap mark does NOT break `pnpm:install`
     (the committed output is already on disk). What catches a stale committed output is the post-install
     `genie:check` drift gate (all phases) — but only where the cold-guard skipped `genie:bootstrap`. In
     CI, `node_modules` is not cached (only the pnpm store + `.pnpm-home` are, keyed on the lockfile), so
     it is absent pre-install and the guard skips → `genie:check` catches the stale output. In a warm
     local tree, `genie:bootstrap` regenerates the bootstrap outputs before `genie:check`, so local
     `check:all` MASKS stale committed bootstrap-output drift — CI (cold) is the catching gate. Verified
     empirically: removing a `package.json.genie.ts` mark drops it from `genie --phase bootstrap` and from
     `bootstrap-closure:check` scope, and a stale committed output is then not regenerated pre-install —
     yet install still succeeds. True install-arbitrated completeness would need a fresh-clone (no
     committed outputs) check — the P2 spot-check considered above and not adopted.

## Evidence

See `.experiments/2026-07-06-generator-phase.md` (run-context evidence: `genie:run` is post-install; CI does
not exercise pre-install; the residual-5 weaver analysis) and decision 0003 for the static gate.
