# BuildProduct and Nix Import Requirements

This subsystem defines the only shared Buck-to-system boundary: a portable
`BuildProduct` and independent Nix import. It refines BUCK-R03, BUCK-R04,
BUCK-R09, and BUCK-R10.

## Assumptions

- **BUCK.PRODUCT-A01 Buck product authority:** Buck produces normalized payload
  bytes and the descriptor that binds them.
- **BUCK.PRODUCT-A02 Nix expectation authority:** The Nix consumer supplies the
  expected descriptor digest and target-platform constraints independently.

## Acceptable Tradeoffs

- **BUCK.PRODUCT-T01 Narrow runtime admission:** Import may support fewer tagged
  runtime contracts than the descriptor vocabulary. Unknown or uninspected
  runtime kinds fail closed.

## Requirements

### Must define a portable product

- **BUCK.PRODUCT-R01 Exact descriptor:** The descriptor must use a versioned,
  exact-field schema and canonical encoding.
- **BUCK.PRODUCT-R02 Byte binding:** The descriptor must bind payload digest,
  size, format, and safe relative entrypoints.
- **BUCK.PRODUCT-R03 Compatibility binding:** The descriptor must bind target
  OS, architecture, ABI, tagged runtime contract, toolchain, recipe, and Buck
  target.
- **BUCK.PRODUCT-R04 No live state:** The descriptor must contain no registry,
  deployment, activation, rollback, health, fleet, or secret state.

### Must import independently

- **BUCK.PRODUCT-R05 Independent expectation:** Import must require an expected
  descriptor digest and expected platform not obtained by trusting the payload.
- **BUCK.PRODUCT-R06 Strict validation:** Import must reject unknown fields,
  missing fields, unsafe paths, unsupported runtime contracts, digest or size
  mismatch, platform mismatch, and unsafe archive contents.
- **BUCK.PRODUCT-R07 Runtime inspection:** Import must inspect the extracted
  runtime against the descriptor before producing a Nix store result.
- **BUCK.PRODUCT-R08 No source fallback:** Import failure must not invoke Buck or
  rebuild repository sources.
- **BUCK.PRODUCT-R09 Immutable result:** Successful import must produce a
  read-only Nix store result containing only verified product content.
