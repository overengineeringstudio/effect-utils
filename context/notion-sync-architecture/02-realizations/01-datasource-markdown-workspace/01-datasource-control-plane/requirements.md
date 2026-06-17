# Requirements - Datasource Control Plane

## Context

These requirements refine the datasource Markdown workspace realization for the
hidden datasource sync state owned by `@overeng/notion-datasource-sync`.

## Requirements

### Must own hidden sync proof

- **NSA.REAL.DMW.DCP-R01 refines: NSA-R06:** Hidden datasource state must own
  outbox, conflict, settlement, lease, watermark, and proof facts.
- **NSA.REAL.DMW.DCP-R02 refines: NSA-R07:** Datasource writes must be accepted
  only from evidence that proves the active authority model permits them.
