# Requirements - Verification And Evidence

## Context

These requirements refine the stack-wide Notion sync architecture for proof,
test, scenario, and live-evidence traceability.

## Requirements

### Must make claims falsifiable

- **NSA.VER-R01 refines: NSA-R08:** A shared invariant must name its proving
  tests, scenario IDs, or live-evidence gap.
- **NSA.VER-R02 refines: NSA-R08:** Placeholder scenario references must be
  temporary and tracked to concrete follow-up work.

### Must gate shared implementation

- **NSA.VER-R03 refines: NSA-R03:** Shared contracts should not graduate to
  shared implementation without at least two realization proofs.
