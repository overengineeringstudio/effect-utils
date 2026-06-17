# Requirements - Shared Sync Contract

## Context

These requirements refine the stack-wide
[Notion Sync Architecture requirements](../requirements.md) for concepts that
can be shared across realizations without sharing one implementation.

## Requirements

### Must stay mechanism-free

- **NSA.SSC-R01 refines: NSA-R03:** Shared contracts must stay mechanism-free
  unless promoted by an explicit decision.

### Must make evidence portable

- **NSA.SSC-R02 refines: NSA-R07:** Proof and evidence contracts must be
  entrypoint-neutral.
- **NSA.SSC-R03 refines: NSA-R08:** Every shared contract must identify how at
  least two realizations verify or intentionally reject it.
