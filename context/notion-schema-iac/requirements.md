# Requirements — Notion native `status` schema convergence

Terms used here are defined in the issue and the spec. "Converge" = make the live
Notion schema match code-owned intent. "Drift" = any difference between the
code-owned schema and the live database.

## Assumptions

- **A1 — The Notion API is effectively add-only for `status`** (version
  2026-03-11, verified by live probe; see `.experiments/0001-...`). Empirically:
  - Adding a new option: supported (the new option lands in the `To-do` group).
  - Recoloring an existing option: rejected (`validation_error: Cannot update
    color of select with id`).
  - Renaming an existing option: silent no-op (HTTP 200, value unchanged).
  - All group operations (create custom group, rename, recolor, regroup
    `option_ids`) — including via a full-array REPLACE payload: silent no-op.
    Groups are forced to the defaults `To-do / In progress / Complete`.
  - The `options` array PATCH has **declarative REPLACE** semantics: an option
    omitted from the payload is **deleted**, not preserved.
  This assumption is load-bearing and external; it must be re-validated when the
  pinned Notion API version changes.

- **A2 — Status schema lives on the data source**, not the database object, in
  API 2026-03-11. Reads use `NotionDataSources.retrieve`; writes use
  `NotionDataSources.update({ dataSourceId, properties })`.

- **A3 — The committed generated `.gen.ts`** (with `schemaMeta`, the default) is
  a faithful, complete snapshot of the live status shape at generation time.
  Verified at the *emission* side: `codegen.ts` already serializes full option
  `{id, name, color}` and group `{id, name, color, option_ids}` into the
  `notionPropertyMeta` annotation. So the data needed for full drift detection is
  already in the file and is usable as the drift oracle.
  **Caveat (current-state gap):** the *consumer* side does not yet read it.
  `parseGeneratedFile` extracts only property `name` + `transformKey`, and
  `computeDiff` leaves option diffing unimplemented (`diff.ts:210` —
  "Options comparison is not implemented yet"; `optionsDiffs` is always empty).
  So R7 is net-new diffing work, not an extension of a working option diff (see
  R7).

## Requirements

- **R1 — Opt-in only.** Convergence acts only on `status` properties explicitly
  declared in the config's `statusProperties`. Introspection/codegen must never
  mutate a status property that was merely observed.

- **R2 — Observe before mutate.** Every apply plans against a *freshly*
  introspected live schema; a stale or missing observation blocks the write.

- **R3 — Classify every difference.** The planner assigns each per-option and
  per-group difference exactly one class: `create` (safe additive write),
  `matches`, `color-drift` / `rename-drift` / `group-drift` (UI-action-required,
  not writable via API), `extra-remote` (option present live, absent in desired),
  or `missing-unaddable`.

- **R4 — Fail closed on destructive and unsupported.** Apply performs only
  `create` operations. `extra-remote` defaults to failing the apply (because the
  REPLACE trap means honoring desired-as-canonical would delete it); UI-only
  classes are reported, never attempted. No deletion is ever issued.

- **R5 — Never trust the 200.** Because rename/group writes return success while
  doing nothing (A1), every applied `create` is confirmed by read-after-write:
  the option must be observably present post-write or the apply fails.

- **R6 — Apply closes the loop.** A successful apply regenerates the affected
  `.gen.ts` so that a subsequent `diff` is clean. The post-apply invariant is:
  `introspect → apply → read-after-write → diff` ends with no drift in the
  applied (additive) dimension.

- **R7 — Comprehensive drift detection, CI-gating.** `diff --exit-code` detects
  drift across all dimensions the API can read — option names, colors, IDs, and
  groups — and can fail CI. This holds even for dimensions apply cannot fix; the
  gate's job is to make UI-only drift visible, not to imply it is auto-fixable.
  Scope note: option/color/group diffing is **net-new** (today's `computeDiff`
  only handles property add/remove/type-change; option diffing is a stub — A3).
  The desired side should be parsed from the `notionPropertyMeta` annotation
  block (structured `{id,name,color}` + groups), which codegen already emits —
  not from the typed-literal union. This is the largest single implementation
  item and must be costed as "build option/group drift + an annotation parser",
  not "tweak the existing diff".

- **R8 — Credential-free testability.** The planner and its classification are
  unit-testable with an in-memory fake gateway (no live Notion). A live e2e
  proves the full loop against a throwaway database and cleans it up.

- **R9 — Structured, reviewable plan output.** Plan/dry-run output lists, per
  difference: property, option/group id, desired name/color, live name/color,
  and the policy decision — suitable for code review and CI logs.

## Non-requirements

- Converging `status` **groups** or existing-option **colors/names** (A1: not
  writable). These are detect-and-report only.
- Notion **view** convergence (separate surface).
- A general schema-mutation engine beyond `status` options. Other property types
  may reuse the patterns later but are not in scope here.
