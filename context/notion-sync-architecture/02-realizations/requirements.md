# Requirements - Realizations

## Context

These requirements refine the stack-wide
[Notion Sync Architecture requirements](../requirements.md) for concrete sync
product shapes.

## Requirements

### Must state local authority

- **NSA.REAL-R01 refines: NSA-R02:** Each realization must state its authority
  model and mutation boundary.
- **NSA.REAL-R02 refines: NSA-R04:** A realization must not inherit another
  realization's conflict or overwrite policy by default.

### Must name evidence

- **NSA.REAL-R03 refines: NSA-R08:** A realization must name its verification
  evidence or explicit evidence gap.
