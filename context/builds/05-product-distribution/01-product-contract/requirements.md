# Portable Product Requirements

This subsystem owns the portable product descriptor and refines BUILD.BUCK-R03
and BUILD.BUCK-R05.

## Assumptions

- **BUILD.DIST.PRODUCT-A01 Producer authority:** Buck produces normalized payload
  bytes and the descriptor that binds them.

## Acceptable Tradeoffs

- **BUILD.DIST.PRODUCT-T01 Runtime admission:** An importer may support fewer
  runtime contracts than the descriptor vocabulary; unsupported kinds fail closed.

## Requirements

### Must define a portable product

- **BUILD.DIST.PRODUCT-R01 Exact descriptor:** The descriptor uses a versioned, exact-field
  schema and canonical encoding.
- **BUILD.DIST.PRODUCT-R02 Byte binding:** The descriptor binds payload digest, size,
  format, and safe relative entrypoints.
- **BUILD.DIST.PRODUCT-R03 Compatibility binding:** The descriptor binds target OS,
  architecture, ABI, tagged runtime contract, toolchain, recipe, and Buck
  target.
- **BUILD.DIST.PRODUCT-R04 No live state:** The descriptor contains no registry,
  deployment, activation, rollback, health, fleet, or secret state
  ([decision 0008](../../.decisions/0008-untrusted-oci-and-offline-nix-authority.md)).

