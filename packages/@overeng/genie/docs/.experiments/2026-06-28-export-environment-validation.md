# Export Environment Validation Evidence

## Question

Can package export environment contracts validate both runtime/source closure and
type-level closure without making Genie validation a bottleneck?

## Prototype Evidence

Throwaway prototypes measured the `@overeng/genie` `.` entry before
implementation:

- runtime import graph scan: roughly 5-60ms depending on cold/warm path
- strict TypeScript proof: roughly 0.4s cold and 0.17-0.28s repeated in process
- broader misdeclared closures can exceed 1s, so strict proofs must be opt-in
  and cacheable

The prototype also showed that a misdeclared `./sdk` isomorphic export is caught
because it pulls node dependencies.

## Implementation Evidence

Focused test command:

```sh
bun test src/runtime/package-json/package-json.unit.test.ts
```

Observed result after implementation:

- 28 tests passed
- strict isomorphic proof for the pure Genie runtime entry completed in about
  465ms on the cold path
- forbidden `node:fs` import fixture was caught by the package-json node
  validation runtime

Quality gates run during implementation:

```sh
devenv tasks run ts:check --no-tui
devenv tasks run lint:check --no-tui --show-output
```

Both passed after formatting and lint fixes.

## Read

Cheap graph validation is suitable for normal package-json validation. Strict
TypeScript proof is valuable but must stay opt-in through `typeProof: 'strict'`.
Successful strict proofs are cached under
`.devenv/task-cache/genie-package-json-export-environments/`.
