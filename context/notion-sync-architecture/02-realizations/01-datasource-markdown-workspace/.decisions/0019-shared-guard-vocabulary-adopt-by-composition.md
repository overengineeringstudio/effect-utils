# Shared guard vocabulary uses adopt-by-composition

Status: accepted

The new `@overeng/notion-property-write` package (per decision 0014) exports the
12 shared property-write guard names. `notion-datasource-sync` defines its full
`GuardName` as a superset:
`Schema.Literal(...propertyWriteGuardNames, ...syncOnlyGuardNames)`. This keeps
sync-only names in the sync package while giving shared property-write names a
single source of truth.

The `PropertyWriteCore` is a pure synchronous evaluator
(`evaluatePropertyWrite(proof, write)`). Evidence acquisition lives in two
Effect-based providers: a standalone-live provider in `notion-md` and a workspace
provider in `notion-datasource-sync`. Safety is determined by the proof, never
by the entrypoint (R12).

**Ratified guard names:**

- **Relation guard name:** use `UnavailableRelationTarget`. Spec prose used `RelationTargetsUnavailable`
  (spec.md:219) but the existing guard is `UnavailableRelationTarget`
  (guards.ts:49). Keeping the existing guard honors R09 by avoiding a second
  name for one invariant; spec prose should use the guard name directly.
- **Settlement guard name:** reuse `ReadAfterWriteMismatch` for shared-mode
  missing settlement context. Do not mint `SettlementContextMissing`; settlement
  absence and settlement mismatch are one proof-failure family for users and
  tests.

## Considered Options

| Option                                                                                                 | Result   | Reason                                                                                     |
| ------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------ |
| Adopt-by-composition: new package exports shared names; datasource-sync defines a superset `GuardName` | Selected | Single source of truth for shared names; sync-only guard names remain in the sync package. |
| Replace datasource-sync `GuardName` entirely with the shared package's type                            | Rejected | Sync-only guard names have no home in the shared package.                                  |

## Consequences

The shared package and the datasource-sync superset use the same canonical guard
names. Spec prose and test cases should use `UnavailableRelationTarget` and
`ReadAfterWriteMismatch` directly instead of preserving aliases.
