# Execution Requirements

This subsystem owns admitted action semantics for every language. It refines
BUILD.BUCK-R02 and BUILD.BUCK-R04 and consumes
[platforms and toolchains](../02-platforms-toolchains/spec.md).

## Assumptions

- **BUILD.BUCK.EXEC-A03 Native result:** Buck's action result and native evidence are
  authoritative for execution.

## Acceptable Tradeoffs

- **BUILD.BUCK.EXEC-T02 Ecosystem executors:** Languages may use distinct typed executor
  payloads implementing the same action lifecycle.

## Requirements

### Actions

- **BUILD.BUCK.EXEC-R06 Declared closure:** An action receives only declared sources,
  dependency closure, configuration, tools, platforms, and policy.
- **BUILD.BUCK.EXEC-R07 Deterministic contract:** Equal configured input produces equal
  declared output where an artifact is promised, and an equal semantic verdict
  for checks and tests
  ([decision 0026](../../.decisions/0026-buck-owned-unit-tests.md)).
- **BUILD.BUCK.EXEC-R08 No live effects:** An action must not install against live state,
  publish, deploy, activate, or mutate anything outside its declared output
  boundary.
- **BUILD.BUCK.EXEC-R09 Typed results:** Results expose typed providers; stdout and
  stderr remain diagnostic streams, never the verdict protocol. Tool failure,
  malformed output, missing declared output, and platform incompatibility stay
  distinguishable.

### Transfer

- **BUILD.BUCK.EXEC-R10 Parity at transfer:** Authority transfer for an operation tuple
  proves semantic parity against the existing producer, a representative
  failure, an undeclared-access failure, and relevant/irrelevant mutation
  controls (BUILD.AUTH-R12); after transfer, normal developer and CI surfaces
  delegate to Buck and the prior producer is deleted (BUILD.AUTH-R09).
  Foundation changes and product joins remain independently reviewable
  ([decision 0007](../../.decisions/0007-sibling-foundations-and-product-joins.md)).
