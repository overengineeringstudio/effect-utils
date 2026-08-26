# Check-Surface Partition for the First Authority Transfer

Date: 2026-08-26 — Host: dev3 (loaded; timings indicative only).

## Question

When Buck2 owns tui-core's typecheck, what exactly changes so the whole-graph
`ts:check` no longer covers tui-core, dependents still typecheck correctly,
and CI green means the union of both surfaces with no gap and no
double-coverage (the deletion mechanics of EXEC-R10 / BUCK-R09)?

## Method

Mapped the real check topology (genie-generated `tsconfig.check.json` /
`tsconfig.emit.json` solutions over `rootTsconfigProjects`; `ts:check` is one
whole-graph `tsgo --build`; CI runs `ts:check:strict` as its own job). Spiked
four partition mechanisms in a scratch clone with `--listFiles` program
inspection, injected type errors on both sides of the boundary, and probes for
the Effect-LSP gate and type-aware lint.

## Result

- **Premise inversion:** a project reference makes dependents consume
  tui-core's BUILT `dist/src/*.d.ts`, not its source (proven via
  `--listFiles` with the reference present vs removed). The repo already
  consumes tui-core across a dist boundary; Buck2 only needs to become the
  writer of that directory.
- Ruled out by experiment: solution-file exclusion is a no-op (`--build`
  walks references transitively; 39/39 projects stay in scope); reference
  removal alone reroutes dependents to SOURCE via package.json
  `exports: "./src/mod.ts"` — silent 5x re-checking, worse than the status
  quo; prebuilt-dist-with-references "works" but deletes nothing and leaves
  two writers on `dist/`.
- **Recommended mechanism (spiked green):** tui-core `exports` gains
  `{"types": "./dist/src/mod.d.ts", "default": "./src/mod.ts"}` and the
  `../tui-core` reference is dropped from all five dependents plus both root
  solutions. Whole-graph check: 39 -> 38 projects, green; a tui-core-internal
  error no longer reddens devenv (exit 0) while the Buck2-side
  `tsgo -p` catches it (exit 1); a breaking API change still surfaces in the
  dependent through the boundary (TS2554 in tui-react) once dist is
  re-emitted.
- Dependent blast radius is 3 real importers (tui-react 16 sites, notion-cli
  1, megarepo 1); genie and tui-stories declare the dep but import it zero
  times (phantom deps).
- **Transfer-PR must-haves or the transfer is fictional:** (1)
  `tsconfig.emit.json` lists tui-core as a root reference — without removing
  it there, devenv keeps write authority over the very `dist/` the check
  surface now trusts (verified: emit rebuilds and rewrites the .d.ts); (2)
  `dist/` is gitignored, so CI must MATERIALIZE the Buck2 artifact before
  `ts:check:strict` — otherwise the `types` condition silently falls back to
  source and CI goes green having transferred nothing. With the shared cache
  this ordering gate is a cache hit.
- Freshness: the boundary has two silent modes — stale dist is a FALSE GREEN
  that survives `--build --force`, and missing dist silently reverts to
  source. tsgo cannot close either (its up-to-date check is mtime-fast-path
  with content check behind it, and never covers this boundary). The ordering
  gate (Buck2's content-keyed rule produces dist in the same run) is what
  makes the mechanism a partition rather than a hazard.
- No-gap probes: the Effect-LSP gate fires under both `tsgo -p` and
  `tsgo --build` (plugin ships inside the effect-tsgo derivation; the Buck2
  rule must read tui-core's own tsconfig to load it). Type-aware lint
  (`oxlint --type-aware`) still covers tui-core under the partition — lint is
  double-coverage, a separate later transfer, not a gap.
- Timing: tui-core is ~1-2% of the check surface (154 ms of a 9-15 s forced
  whole-graph run; warm no-op 576 ms). Phase 1 buys no wall clock; its value
  is proving the transfer mechanics on a cheap, representative package.
- Developer-surface note: under the partition, tsserver resolves `types` ->
  dist, so editors see stale-dist lag for the first time (declarationMap keeps
  go-to-definition landing in source).

## Conclusion

The transfer PR's shape is: exports `types` condition + reference removal
from five dependents and BOTH root solutions (check and emit), a Buck2 rule
that writes `dist/` (reading tui-core's tsconfig for the LSP plugin), and a
CI ordering gate that materializes the artifact before `ts:check:strict`.
Model the exclusion as a genie predicate on tsconfig data (the
`isTsconfigReferenceTarget` precedent), never as registry deletion (the
registry throws on drift by design).

## VRS Impact

Feeds the roadmap Phase 1 transfer-PR definition and EXEC-R10's parity-gate
content for the first transfer; the ordering gate realizes DEPS-R06's
loud-staleness principle at the check boundary; identifies two phantom
`@overeng/tui-core` dependencies (genie, tui-stories) for cleanup.
