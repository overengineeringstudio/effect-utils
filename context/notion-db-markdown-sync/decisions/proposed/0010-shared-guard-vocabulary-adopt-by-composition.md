# Phase 3 shared guard vocabulary: adopt-by-composition with two naming flags

Status: proposed

The new `@overeng/notion-property-write` package (per D3/0003) exports the ~11
shared property-write guard names. `notion-datasource-sync` defines its full
`GuardName` as a superset:
`Schema.Literal(...propertyWriteGuardNames, ...syncOnlyGuardNames)`. This keeps
all 108 existing call sites valid (datasource-sync already owns a 46-member
`GuardName` literal used by 108 call sites) and gives shared names a single
source of truth.

The `PropertyWriteCore` is a pure synchronous evaluator
(`evaluatePropertyWrite(proof, write)`). Evidence acquisition lives in two
Effect-based providers: a standalone-live provider in `notion-md` and a workspace
provider in `notion-datasource-sync`. Safety is determined by the proof, never
by the entrypoint (R12).

**Two naming flags pending human ratification (durable guard vocabulary):**

- **Relation guard name:** spec prose uses `RelationTargetsUnavailable`
  (spec.md:219) but the existing guard is `UnavailableRelationTarget`
  (guards.ts:49). Chosen: keep `UnavailableRelationTarget` to honor R09 (avoid a
  second name for one invariant); treat the spec prose as a human-facing alias.
  Ratification needed to confirm or rename before the vocabulary ossifies.
- **Settlement guard name:** the spec names no settlement guard. Chosen: reuse
  `ReadAfterWriteMismatch` for shared-mode missing settlement context. Alternative:
  mint `SettlementContextMissing`. Ratification needed to pick one before the guard
  is embedded across test cases.

## Considered Options

| Option                                                                                                 | Result   | Reason                                                                                              |
| ------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| Adopt-by-composition: new package exports shared names; datasource-sync defines a superset `GuardName` | Selected | Preserves all 108 existing usages; single source of truth for shared names; no churn at call sites. |
| Replace datasource-sync `GuardName` entirely with the shared package's type                            | Rejected | Breaks 108 call sites; sync-only guard names have no home in the shared package.                    |

## Consequences

Both naming flags are reversible literal-rename decisions but must be ratified
before the durable guard vocabulary ossifies across test cases and call sites.

- If `UnavailableRelationTarget` is ratified: update spec prose to match (or
  document the alias explicitly).
- If the spec name `RelationTargetsUnavailable` is preferred: rename the existing
  guard and update all 108 call sites.
- For the settlement guard: whichever name is ratified becomes the canonical guard
  in both the shared package and the datasource-sync superset.
