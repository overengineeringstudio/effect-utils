# Decision 0004: Generator phase + an empirical cold-proof makes bootstrap-safety demonstrated (not install-ordered)

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

Introduce a **generator phase** and make bootstrap-safety **empirically demonstrated** (a real cold run),
with the static closure check as fast feedback.

- **Phase is a per-generator property.** `design-time` is the DEFAULT (unmarked). `bootstrap` is OPT-IN
  via a **static source pragma** `// @genie-bootstrap` — a namespace-prefixed valueless flag mirroring
  TypeScript pragma grammar (`@ts-nocheck`/`@ts-check`), read from raw source without importing the
  generator (importing a design-time generator would itself need `effect`).
- **Enforcement is a real cold run, not a static proxy.** A CI job (`bootstrap:cold-proof`) checks out
  fresh with no `node_modules`, runs the bootstrap-phase generators with the **self-contained nix genie**
  (deps baked into the store, needs no install), then runs `pnpm:install`, asserting both succeed. This
  exercises the exact pre-install path and turns bootstrap-safety from _asserted_ into _demonstrated_.
  (Proven feasible: a bootstrap generator's full closure bundles with zero
  `effect`/`@effect/*`/`@overeng/otel-contract`; the nix genie is store-only by construction.)
- **The static bootstrap-closure gate (0003) is fast local feedback**, scoped to `@genie-bootstrap`
  generators (reads the pragma statically; checks only their closures; zero tolerance). The quick pre-check
  for the cold run, not the authority.
- **The baseline is deleted.** Weaver generators are `design-time` → structurally out of scope. No baseline,
  no allowlist, no enumerated exceptions.
- **Install ordering is NOT the arbiter (superseded).** An earlier form wired `pnpm:install` to depend on a
  `genie:prepare` so install would fail on a missing/stale bootstrap output. Verified during implementation
  that this does **not** hold: source-mode genie can't run cold (the `genie:bootstrap` task cold-guards to a
  no-op), and committed outputs (T01) mean install succeeds with the on-disk `package.json` regardless. That
  edge added cost + a failure mode without enforcing anything, so it is **removed**; the cold run is the
  empirical authority. Committed outputs remain (T01 untouched).
- **Completeness is an accepted residual (open).** A _new_ install-input generator that forgets
  `// @genie-bootstrap` silently escapes the gate. Closing it structurally needs either uncommitted outputs
  (infeasible — the nix genie builds _from_ the committed `package.json`; deadlock) or a hardcoded
  "install-input" completeness check (rejected as unprincipled). The gap is low-risk (new generators inherit
  bootstrap-safe builders; `genie:check` still catches output drift) and is left open, closeable later with
  the hardcoded check only if it ever bites.

## Options considered

- **Scope derived from install-input filenames (Q1-A).** Rejected: hardcodes a convention the owner
  explicitly rejected; can't express a pre-install need that isn't an install input.
- **Declared phase, opt-OUT of a bootstrap default with required reason (Q2).** Superseded by opt-IN:
  the bootstrap-critical set is small; marking the few is less overhead than annotating the ~80 design-time
  generators, and it makes the pre-install contract a small explicit positive set.
- **Static completeness check (glob install-input generators, assert each is marked — the 0005
  no-orphan-seam pattern).** Rejected: still hardcodes "which outputs are install inputs." A static check
  cannot know what install needs.
- **Empirical cold-proof (P2, chosen):** run marked generators in a fresh, no-`node_modules` tree with the
  self-contained nix genie, then run frozen install. This is the strongest feasible proof in a committed-output
  repo: it exercises the exact bootstrap execution path and install acceptance without adding a hot-path task edge.
- **Structural ordering (P1).** Rejected/superseded: attractive in principle, but it did not enforce the
  contract here. Source-mode genie cannot run cold, and committed outputs let install succeed without proving
  the generator ran or was marked.

## Consequences

- Genie gains a phase-selection capability: `genie --phase bootstrap` runs only `// @genie-bootstrap`-marked
  generators. No devenv task-graph reorder — `pnpm:install` has no `genie` dependency.
- Bootstrap-safety becomes _empirically demonstrated_ (a real cold run of the marked set, then install),
  not asserted by a static proxy. The static gate remains for fast feedback.
- No baseline file, no allowlist. The residual weaver generators are `design-time` by declaration.
- Residual risk (accepted, open): the phase flag is "just a string"; a _wrong_ mark is caught empirically
  (a bootstrap generator that can't run cold fails `bootstrap:cold-proof`), but a _forgotten_ mark on a new
  install-input generator escapes both the static gate and the cold-proof (which runs only the marked set),
  because committed outputs mean install still succeeds. See the accepted-residual note in the decision.

## Implementation notes (as built)

- **Phase flag.** Declared as a valueless `// @genie-bootstrap` line comment (mirroring `@ts-nocheck`
  grammar), read from raw source text (`src/core/phase.ts`, `parseGeneratorPhase`, regex
  `/^[ \t]*\/\/[ \t]*@genie-bootstrap(?![\w-])/m`) — no import, no TS parse. `design-time` is the default
  (no marker). The bootstrap set is the 35 `package.json.genie.ts` + `pnpm-workspace.yaml.genie.ts`
  (36 marks). A per-file flag (not a `package.json.genie.ts` filename rule) is used precisely because R32
  forbids a hardcoded install-input catalog.
- **No install-ordering task.** An earlier build wired a `genie:bootstrap` task (`genie --phase bootstrap`,
  cold-guarded) with `pnpm:install.after = [ "genie:bootstrap" ]`. It was removed: it arbitrated nothing
  (source-mode genie can't run cold, so it no-op'd on a fresh clone; committed outputs (T01) satisfy install
  regardless), while adding cost to every warm install and a new failure mode on the most-depended-on task.
  The devenv graph is now unchanged by this decision except for the additive `bootstrap:cold-proof` task.
- **`bootstrap:cold-proof` (the empirical authority, R32).** `genie/ci-scripts/bootstrap-cold-proof.sh`
  (devenv task + a dedicated CI lane in `ci.yml.genie.ts`): builds the self-contained nix genie (`.#genie`,
  a `bun --compile` binary with deps baked into the store — it runs with no `node_modules`, unlike
  source-mode genie), `git archive HEAD`s a `node_modules`-free tree of the committed source into a temp dir
  outside the repo, runs `genie --phase bootstrap` cold there (asserting the count of generators run matches
  the independently-counted `// @genie-bootstrap` set, via `--output json`, and that none errored), then runs
  `pnpm install --frozen-lockfile` there. Both succeeding is the demonstration. The cold generate also runs
  validation, including the strict tsgo export-type proof on genie's isomorphic `.` entry
  (`src/runtime/mod.ts`), whose type closure reaches no `node_modules`-resident types, so it compiles cold.
  Kept out of `check:all` (heavier than the product checks).
- **Accepted residual (completeness, open — the honest result).** In this committed-output, source-mode
  repo the cold-proof proves the _marked_ set runs cold and installs, but cannot prove the marked set is
  _complete_: a forgotten `// @genie-bootstrap` on a new install-input generator does not break the cold
  `pnpm install` (the committed output is already on disk). The all-phase `genie:check` drift gate still
  catches a stale committed output. Closing the completeness gap structurally would need uncommitted outputs
  (infeasible — the nix genie is built _from_ the committed outputs; deadlock) or a hardcoded install-input
  catalog (rejected by R32). Left open, closeable later with the hardcoded check only if it bites.

## Evidence

See `.experiments/2026-07-06-generator-phase.md` (run-context evidence: `genie:run` is post-install; CI does
not exercise pre-install; the residual-5 weaver analysis) and decision 0003 for the static gate. The
cold-proof itself is the running evidence for R32 (`bootstrap:cold-proof`).
