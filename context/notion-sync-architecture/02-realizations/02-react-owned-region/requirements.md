# Requirements - React Owned Region

## Context

These requirements refine the stack-wide Notion sync architecture for
`@overeng/notion-react`'s owned-region renderer contract.

## Requirements

### Must preserve owned-region semantics

- **NSA.REAL.REACT-R01 refines: NSA-R05:** React sync must remain an
  owned-region renderer realization, not the datasource workspace planner.
- **NSA.REAL.REACT-R02 refines: NSA-R03:** React may refine shared snapshot,
  digest, checkpoint, mutation, drift, and fallback vocabulary.
- **NSA.REAL.REACT-R03 refines: NSA-R04:** React overwrite semantics inside the
  owned region must not be inherited by shared-mode datasource sync.
