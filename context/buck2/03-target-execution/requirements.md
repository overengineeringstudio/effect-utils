# Target Execution Requirements

This subsystem defines how configured semantic operations become authoritative
Buck actions. It refines BUCK-R01, BUCK-R02, and BUCK-R08.

## Assumptions

- **BUCK.EXEC-A01 Configured graph:** Semantic operations, dependency handles,
  tools, and platforms have passed their upstream validation.
- **BUCK.EXEC-A02 Native result:** Buck's action result and native evidence are
  authoritative for execution.

## Acceptable Tradeoffs

- **BUCK.EXEC-T01 Ecosystem-specific executors:** Different ecosystems may use
  distinct typed executor payloads when they implement the same kernel action
  lifecycle.

## Requirements

### Must execute bounded deterministic work

- **BUCK.EXEC-R01 Declared closure:** An action must receive only declared
  sources, dependency closure, configuration, tools, platforms, and policy.
- **BUCK.EXEC-R02 Deterministic contract:** Equal configured operation input
  must produce equal declared output where the operation contract promises an
  artifact, and equal semantic verdict for checks and tests.
- **BUCK.EXEC-R03 No live effects:** An action must not install dependencies,
  publish artifacts, deploy, activate, roll back, probe health, or mutate state
  outside its declared output boundary.
- **BUCK.EXEC-R04 Stable providers:** Results must expose typed providers rather
  than requiring consumers to scrape stdout or guess output paths.
- **BUCK.EXEC-R05 Truthful failure:** Tool failure, malformed output, missing
  declared output, and platform incompatibility must remain distinguishable.

### Must become the sole producer

- **BUCK.EXEC-R06 Parity gate:** Before authority transfer, an operation must
  prove semantic parity against the existing producer plus adversarial negative
  cases.
- **BUCK.EXEC-R07 Exact invalidation:** Relevant and irrelevant mutations must
  prove the declared action boundary is neither under- nor over-broad.
- **BUCK.EXEC-R08 Producer removal:** After admission, normal developer and CI
  surfaces must delegate to Buck and the prior equivalent producer must be
  absent.
