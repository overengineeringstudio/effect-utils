# Effect 4 rc.111 flip — follow-ups

Companion to the atomic cohort flip (`effect@4.0.0-rc.111`). Items below are
known post-flip work, grouped by kind. None block type-greenness; each needs an
owner decision or upstream movement before/with test-suite convergence.

## Upstream (Effect) issues to file / track

1. ~~**cli-A-nested-terminator-loss**~~ — RESOLVED FIXED UPSTREAM (beta.103,
   PR #6692, issue #6690 closed). Alignment register updated.
2. **CLI validation help on stdout** (bucket C) — RESOLVED by locked full
   rebaseline decision; ci-tools snapshots regenerated (commit 01f823c8b).
3. **ShowHelp `TypeError: Attempted to assign to readonly property` under Bun**
   — NOT an upstream bug: our `CliVersion.enrichErrors` used Object.assign over
   a v4 getter-only `message` accessor (fixed d53532b57). Standalone repro
   under Bun 1.3.13 / Node 24 could not reproduce; do not file upstream.
4. **FileSystem.watch recursion** — premise corrected at rc.111:
   `{ recursive }` is opt-in again (Node backend defaults false). Design study
   in watch-recursion-experiments.md; refactor of genie/notion-md consumers
   still open.
5. **Prompt PTY ANSI byte drift** — shorter SGR/reset sequences; raw-terminal
   parsers and PTY snapshots need owner review before rebaseline.

## Wire/format decisions recorded during migration

6. **RPC string request IDs accepted** — v3 rejected non-BigInt ids; wire
   baseline updated. Decide client-side id validation policy or versioning for
   persisted envelopes (see rpc-failure-cause-wire-shape).
7. **`JSONSchema.make` → `Schema.toJsonSchemaDocument`** — generated JSON
   Schema is now draft-2020-12 Document shape (megarepo generator artifact).
8. **`NonEmptyTrimmedString` trim semantics dropped** in ci-tools provider
   config schemas (`NonEmptyString` substitution); restore via
   `.check(isTrimmed())` if external inputs are ever in scope.
9. **Span-header allowlist patch retired** — re-express the v3
   `@effect/platform` http.client header allowlist against core
   `effect/unstable/http` tracing (platform-patch-analysis.md) before enabling
   verbose Notion traffic spans again.

## In-repo cleanup

10. **Marker sweep**: resolve remaining `TODO(live-migration:effect-3-4)`
    markers once differential baselines run green under rc.111
    (`context/effect-4/check-baseline-*.ts` gates).
11. **Test-suite convergence**: per-slice suites pass individually; full
    monorepo vitest pass + baseline gates to be wired into devenv tasks and CI.
12. **Pre-existing genie lint noise** (out of flip scope):
    `genie/ci-scripts/pr-snapshot-artifact*.mjs` await-in-loop/named-args,
    `genie/tsconfig-projects.ts` exports-first trio, `support-files.ts`
    boolean-coercion, `pnpm-install-contract.json.genie.ts`,
    `genie/otel-scrape-registry.ts` named-args.
13. **Annotation key consumers**: Restate annotation ids moved symbol → namespaced
    strings; downstream readers must switch to the exported constants.
