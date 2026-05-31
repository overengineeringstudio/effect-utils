# Decompose the VRS into per-sub-system directories

Status: accepted

The VRS is organized into per-sub-system directories under
`docs/vrs/subsystems/`, each owning its own `requirements.md` slice and `spec.md`
slice. The top-level requirements document owns global assumptions,
cross-cutting requirements, and the sub-system trace index.

## Sub-system list

Each becomes `subsystems/<name>/` with `requirements.md` + `spec.md`:

1. `domain-model` — canonical types, property/row/body/file model, hashing, IDs
2. `sync-store` — SQLite control plane: events, projections, outbox, leases, store migrations
3. `notion-gateway` — API version contract, capability preflight, pagination, query completeness
4. `body-adapter` — `PageBodySyncPort`, NotionMD boundary, body guards
5. `local-workspace` — filesystem, path claims, materialization
6. `replica-api` — public `<database-id>.sqlite` surfaces + write-intent contract (user-facing)
7. `planner-guards` — planner decisions, guard matrix, conflict classification, delete/move/restore
8. `schema-migration` — additive schema writes + destructive migration policy, two-phase plan/apply, `migrate schema`
9. `sync-orchestration` — one-shot pull→plan→push→settle flow
10. `watch-daemon` — daemon loop, scheduling, leases (absorbs the webhook receiver as daemon intake)
11. `cli` — command surface, dry-run, structured output envelope

## Requirements ownership

Each sub-system owns its requirements under a namespaced ID prefix (e.g.
`STORE-R*`, `GW-R*`, `REPLICA-R*`). The top-level `requirements.md` contains:

- genuinely cross-cutting constraints (no-silent-LWW safety doctrine, secret
  safety, observability/telemetry, layer boundaries),
- domain **Assumptions**,
- a trace index mapping each sub-system to its namespaced requirement range.

Tradeoffs live in the document that owns the affected sub-system contract.
This keeps sub-system contracts self-contained and cross-cutting requirements
single-sourced.

## Cross-cutting (top-level, not a sub-system dir)

- observability / telemetry (spans apply to every sub-system)
- verification strategy + guard-matrix traceability (the guard matrix stays single-sourced)
- safety doctrine, secret safety, layer boundaries, assumptions

`vision.md` stays a single global document. See [[0002-mutation-support-matrix]]
for the user-facing write-support contract that `replica-api` and
`schema-migration` share.
