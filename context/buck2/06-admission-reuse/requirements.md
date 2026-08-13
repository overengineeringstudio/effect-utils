# Admission and Reuse Requirements

This subsystem defines authority transfer and cross-repository conformance. It
refines BUCK-R16 and BUCK-R17.

## Assumptions

- **BUCK.ADMIT-A01 Exact tuple:** Admission applies to one configured operation,
  target platform, execution platform, toolchain, policy, and trust tuple.
- **BUCK.ADMIT-A02 Consumer decision:** Each repository or control plane owns
  the decision to admit a tuple.

## Acceptable Tradeoffs

- **BUCK.ADMIT-T01 Incremental coverage:** Operations and platform tuples may be
  admitted independently; unsupported tuples remain explicit.

## Requirements

### Must transfer authority explicitly

- **BUCK.ADMIT-R01 Complete predicate:** Admission must require graph freshness,
  hermetic execution, semantic parity, causal invalidation, native evidence,
  and any required product-import checks for the exact tuple.
- **BUCK.ADMIT-R02 No partial verdict:** Missing or incomparable evidence must
  produce no verdict and must not transfer authority.
- **BUCK.ADMIT-R03 Atomic contraction:** The change that consumes a completed
  admission must route normal entrypoints to Buck and remove the superseded
  producer without a permanent fallback.
- **BUCK.ADMIT-R04 Separate capabilities:** Local execution, cache read, cache
  write, remote execution, product consumption, and system import must be
  granted independently.

### Must compound without centralizing consumers

- **BUCK.ADMIT-R05 Kernel conformance:** Shared kernel changes must pass public
  fixtures and at least two independent repository-adapter suites before a
  cross-repository compatibility claim.
- **BUCK.ADMIT-R06 Private isolation:** Conformance records must not copy private
  graphs, labels, paths, or policies into the public kernel.
- **BUCK.ADMIT-R07 Reuse isolation:** Writable cache capabilities must remain
  scoped by compatible principals; cross-trust reuse requires immutable bytes
  and consumer verification.
