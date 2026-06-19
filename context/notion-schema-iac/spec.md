# Spec — Notion native `status` schema convergence

Implements `vision.md` under the constraints in `requirements.md`. Lives in
`@overeng/notion-cli`, extending the existing `schema` command group; the planner
is a testable module alongside `diff.ts` / `codegen.ts`.

## Source-of-truth model (hybrid)

Two desired-state roles, each backed by the surface it fits:

- **Drift oracle = committed generated `.gen.ts`** (R7, A3). `codegen.ts` already
  serializes the full live shape (option `{id,name,color}`, group
  `{id,name,color,option_ids}`) into the `notionPropertyMeta` annotation, so no
  new authored data is needed. **But** the current `parseGeneratedFile` reads
  only `name`+`transformKey` and `computeDiff` stubs out option diffing
  (`diff.ts:210`). Realizing R7 means: parse the annotation block and implement
  option/color/group diffing from scratch — the largest work item here.
- **Apply intent = `statusProperties` config block** (R1). A derived file cannot
  express an option that does not yet exist live, so additive apply needs an
  authored desired list. Colors/groups here are advisory (drift-report only;
  not applyable).

Consistency rule: option names in `statusProperties` should be a subset of (or,
post-apply, equal to) those in the committed `.gen.ts`. `check:*` may assert this.

## Config surface

Extend `DatabaseConfig` (`config-def.ts`) with an optional, opt-in field:

```ts
statusProperties?: Record<string /* property name */, {
  /** Desired option names. Missing ones are created on apply. */
  options: ReadonlyArray<string>
  /** Advisory desired colors (drift-report only; API cannot apply). */
  colors?: Record<string /* option name */, SelectColor>
  policy?: {
    /** Create options present in `options` but absent live. Default true. */
    createMissing?: boolean
    /** Live option absent from `options`: 'fail' (default) | 'ignore' | 'warn'. */
    extras?: 'fail' | 'ignore' | 'warn'
  }
}>
```

A `status` property not listed here is never mutated (R1).

## Classification (planner)

For an opted-in property, the planner reads live (R2) and emits one decision per
option and per group:

| Class | Condition | Apply action |
| --- | --- | --- |
| `create` | desired option name not present live | create it (only write) |
| `matches` | desired option present, color matches | none |
| `color-drift` | option present, live color ≠ advisory color | report (UI-only) |
| `rename-drift` | id maps to a different name than desired | report (UI-only) |
| `extra-remote` | live option not in desired `options` | `policy.extras` |
| `group-drift` | live groups/membership ≠ generated `.gen.ts` | report (UI-only) |

`extra-remote = fail` is the default because the REPLACE trap (A1) means any
write that omits the extra would delete it; failing closed prevents that path.

## Commands

- `schema apply --config <c> [--database <id>] [--dry-run] [--exit-code]` —
  **implemented.** The convergence loop, and (with `--dry-run --exit-code`) the
  status drift CI gate. The issue frames status drift as "from desired config",
  i.e. config-vs-live, which the planner already computes — so the gate reuses
  the tested planner rather than parsing the generated file. `--exit-code` fails
  non-zero on pending creates (dry-run) plus UI-only color/missing drift.
- `schema diff [--exit-code]` (file-vs-live) — **follow-up, not yet done.**
  Today's `computeDiff` only handles property add/remove/type-change; option
  diffing is a stub (`diff.ts:210`, `optionsDiffs` always empty). Extending it
  to option colors/IDs and **group** drift (by parsing the `notionPropertyMeta`
  annotation the codegen already emits) detects a different thing than the apply
  gate: staleness of the committed `.gen.ts` vs live (incl. groups, which the
  config does not carry). This is the largest remaining item.
- `schema apply` convergence loop steps:
  1. introspect live data-source schema (R2);
  2. classify against `statusProperties` (and `.gen.ts` for group/color drift);
  3. `--dry-run`: print the structured plan (R9) and stop;
  4. issue `create` writes only, via `NotionDataSources.update` with a
     read-modify-write **full** options array (live options by id + new ones) to
     avoid the REPLACE trap;
  5. read-after-write verify each created option is present (R5);
  6. regenerate the affected `.gen.ts` (R6);
  7. exit non-zero if any `extra-remote=fail` or unverified write occurred.

Existing `generate` / `generate-config` / `introspect` are unchanged.

## Write primitive

`NotionDataSources.update({ dataSourceId, properties: { <Status>: { status: {
options: [...full RMW set...] } } } })`. Groups are never sent (A1). The
full-array RMW is mandatory: sending only new options deletes the rest.

## Testing

- **Unit (fake gateway, R8):** one case per classification row — create, matches,
  color-drift, rename-drift, extra-remote (fail/ignore/warn), group-drift,
  plus the REPLACE-trap guard (omitting live options must never be issued) and
  the read-after-write-mismatch path (gateway returns 200 but option absent →
  apply fails).
- **Live e2e:** create a throwaway database in the test workspace, declare a
  desired option set with one missing option, `apply`, assert the option exists
  (read-after-write), assert `diff --exit-code` is clean, then archive the
  database. Mirrors the investigation probes.

## Implementation status

Delivered in `@overeng/notion-cli` (issue #803):

- `status-converge.ts` — pure planner (`planStatusConvergence`) + REPLACE-trap-safe
  `buildAddOptionsPayload`; unit tests for every classification row.
- `status-converge-apply.ts` — `applyStatusConvergence` (observe → plan →
  fail-closed → safe write → read-after-write verify); `StatusConvergeError`.
- `config-def.ts` / `config.ts` — opt-in `statusProperties` on `DatabaseConfig`,
  threaded through defaults merge and `ResolvedDatabaseConfig`.
- `commands/schema/mod.ts` — `schema apply [--dry-run] [--exit-code] [--database]`,
  structured plan output, post-apply `.gen.ts` regeneration, non-zero exit on
  blocked/unverified and (with `--exit-code`) on drift.
- `status-converge.integration.test.ts` — live e2e (create-missing →
  read-after-write, idempotent re-apply, fail-closed-without-delete, dry-run).
  Verified live; CLI-level apply + `--exit-code` gate verified end-to-end.

Follow-ups (tracked in `open-questions.md`): file-vs-live `diff` colors/groups
extension and group-drift detection; fake-gateway unit tests for the apply
executor (currently covered by the live e2e + pure-planner unit tests).

## Notes on the issue's original sketch

The issue proposed converging groups, option colors, regrouping, and a rich
destructive policy. A1 makes the group/color/rename parts un-applyable; this spec
demotes them to drift-report-only and keeps apply to the single safe write
(create option). The destructive policy collapses to `extras` because deletion is
never issued.
