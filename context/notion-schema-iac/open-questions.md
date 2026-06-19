# Open questions

- **OQ1 — In-use option deletion behavior.** Does Notion refuse to delete a
  `status` option that is in use by a page row, or delete it silently (clearing
  the page values)? Not yet probed cleanly. **Low priority / non-blocking:** the
  planner fails closed on all deletion (`extras=fail` default, R4), so no
  deletion is ever issued regardless. Resolving it would only improve the
  `extra-remote` diagnostic ("in use by N rows"). Probe when convenient.

- **OQ2 — API version drift.** The capability matrix (experiment 0001 / A1) is
  pinned to Notion API 2026-03-11. When the repo bumps the pinned version,
  re-run experiment 0001 — additive-only may relax (e.g. recolor/groups become
  writable), which would let the planner promote UI-only classes to applyable.
  Blocked on a future version bump; not actionable now.

- **OQ3 — Consistency enforcement strength.** Should the `statusProperties`
  option-names ⊆ `.gen.ts` consistency rule be a hard `check:*` failure, a
  `diff` warning, or left implicit? Leaning `check:*` assertion, but defer until
  the failure mode is observed in practice.

- **OQ4 — file-vs-live `diff` colors/groups + group drift (follow-up).** The
  status drift CI gate is delivered as `apply --dry-run --exit-code`
  (config-vs-live: option name/color/missing). Two things it does NOT cover:
  (a) **group** drift — groups aren't in the config desired set; and (b)
  staleness of the committed `.gen.ts` vs live for colors/groups (the file-vs-live
  `diff`, still a stub at `diff.ts:210`). Closing these means parsing the
  `notionPropertyMeta` annotation codegen already emits. Largest remaining item;
  not started.

- **OQ5 — fake-gateway unit tests for the apply executor (follow-up).** The pure
  planner has full unit coverage and the executor is covered by the live e2e. A
  credential-free fake-gateway test of `applyStatusConvergence` (esp. the
  read-after-write-mismatch path, where the API returns 200 but the option is
  absent) would let CI exercise the executor without live creds. Not started.
