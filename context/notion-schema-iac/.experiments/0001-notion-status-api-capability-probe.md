# Experiment 0001 — Notion `status` API write-capability probe

**Question:** Which native `status` schema operations does the Notion API
actually support, so the convergence planner can classify them correctly?

**Method:** Live probes against a disposable test database (Notion API version
2026-03-11). Each operation isolated in its own request; mutating tests used
full-array REPLACE payloads to rule out partial-payload artifacts; the database
was archived afterward. (Throwaway DB/page/token identifiers intentionally omitted
— this repo is public.)

**Result:**

| Operation | Outcome |
| --- | --- |
| Create `status` with custom **options** (name + color) | supported |
| Create `status` with custom **group** names/colors/option_ids | ignored — forced to defaults `To-do / In progress / Complete` |
| **Add** a new option (RMW full options array) | supported; new option lands in `To-do` |
| **Production primitive** — echo all existing by `id` + append one `{name,color}` | confirmed preserves all existing AND appends (probe5); this is the only safe write |
| **Recolor** an existing option (`{id,name,color}`, full array) | rejected: `validation_error: Cannot update color of select with id` |
| **Rename** an existing option (`{id,name,color}`, full array) | silent no-op — HTTP 200, name unchanged |
| **Delete** an option by omitting it from the array | deleted (REPLACE semantics); confirmed for an unused option |
| Any **group** op (rename/recolor/regroup/add) via full-array REPLACE | silent no-op — HTTP 200, groups unchanged |

**Conclusion:** `status` is effectively **add-only**. Existing-option color/name
edits and all group operations are unsupported (rejected or silently ignored).
The `options` PATCH is **declarative REPLACE**: omitted options are deleted.

**Two danger modes for any IaC layer:**
1. REPLACE semantics silently deletes options not echoed back → always
   read-modify-write the full live set by id; treat "live option not in desired"
   as an explicit (fail-closed) decision, never an implicit omission.
2. Rename/group writes return 200 while doing nothing → never trust the 200;
   read-after-write verify every intended change.

**Caveat / open:** The published Notion docs claim existing select-option color
and description are updatable; the live API contradicts this for `status`. Treat
the live probe as authoritative and **re-run this experiment when the pinned
Notion API version changes** — the capability matrix is version-dependent.

Still un-probed (deliberately, because the planner fails closed on deletion
regardless): whether Notion *refuses* to delete an option that is in use by a
page row, or deletes it silently. Tracked in `open-questions.md`.
