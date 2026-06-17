# Requirements - Notion Sync Architecture

## Context

These requirements define the stack-wide contract for Notion sync architecture.
Descendant VRS nodes refine these requirements through path-scoped IDs and must
not contradict them.

## Assumptions

- **NSA-A01 Multiple authority models:** Datasource workspaces, `.nmd` page
  sync, and React-owned regions have overlapping sync mechanics but different
  authority models.
- **NSA-A02 Contract before engine:** Shared vocabulary, evidence semantics,
  and verification come before shared implementation extraction.
- **NSA-A03 Package VRS remains binding:** Package VRS docs remain binding for
  package-local behavior, but stack-level conflicts resolve through this tree.

## Acceptable Tradeoffs

- **NSA-T01 Hierarchy over flatness:** The VRS may use more directories when
  that prevents unrelated realizations from sharing a misleading parent.
- **NSA-T02 Explicit duplication before premature abstraction:** Similar code
  may remain package-local until the shared invariant is proven and named.
- **NSA-T03 Migration churn:** Existing VRS paths may move once to establish a
  cleaner long-term source of truth.

## Requirements

### Must keep one stack source of truth

- **NSA-R01 Canonical stack root:** Stack-wide Notion sync architecture
  decisions must live in this VRS tree.
- **NSA-R02 Realization boundaries:** A realization must state its authority
  model, user surface, hidden state, mutation boundary, and conflict/drift
  policy.
- **NSA-R03 Shared contract boundary:** Shared sync contracts must be pure
  vocabulary, evidence, planning, result, and verification contracts unless a
  descendant decision explicitly promotes a mechanism to shared implementation.

### Must preserve realization boundaries

- **NSA-R04 No authority collapse:** A realization must not inherit another
  realization's authority model by proximity in the tree.
- **NSA-R05 React owned-region boundary:** React sync may refine shared snapshot
  and mutation vocabulary, but it must not be treated as the datasource
  workspace planner or as the NotionMD clean-base adoption path.
- **NSA-R06 Datasource Markdown workspace boundary:** The datasource plus `.nmd`
  workspace realization owns composition of SQL user surfaces, `.nmd` page
  surfaces, hidden control state, outbox, conflicts, and settlement.

### Must make safety evidence reusable

- **NSA-R07 Evidence over entrypoint:** Mutation safety must be decided by the
  available evidence and authority model, not by the package entrypoint that
  initiated the command.
- **NSA-R08 Verification traceability:** Any claimed shared invariant must have
  a verification home that identifies the proving tests, scenarios, or accepted
  live-evidence gap.
