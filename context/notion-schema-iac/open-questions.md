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
  the planner exists and the failure mode is observed in practice.
