# Pattern: cause-extractors

**Area:** Cause inspection **Kind:** semantic **Our usage:** about 61 references span the
repository; the measured package heatmap includes `megarepo`, `tui-react`,
`notion-datasource-sync`, `utils`, `restate-effect`, `notion-md`, `otel-contract`,
`notion-react`, `notion-cli`, `effect-rpc-tanstack`, and `npm-release`.

## Shape changes first

- A v4 `Cause<E>` is flat: `{ reasons: ReadonlyArray<Reason<E>> }`, where each reason is a `Fail`,
  `Die`, or `Interrupt`. Code that traversed the recursive v3 tree must be rewritten around the
  ordered `reasons` array.
- `Cause.findDefect` returns `Result.Result<unknown, Cause<E>>`, not `Option<unknown>`.
- Replacements for `Cause.failures` and `Cause.defects` are ordinary arrays, not `Chunk`s.

## v3

```ts
const firstFailure = Cause.failureOption(cause)
const firstDefect = Cause.dieOption(cause)

const failures = Cause.failures(cause) // Chunk<E>
const defects = Cause.defects(cause) // Chunk<unknown>

const interruptedOnly = Cause.isInterruptedOnly(cause)
const hasAnyInterrupt = Cause.isInterrupted(cause)
```

## v4

```ts
const firstFailure = Cause.findErrorOption(cause)

const firstDefectResult = Cause.findDefect(cause)
const firstDefect = Result.getSuccess(firstDefectResult) // Option<unknown>

const failures = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error) // Array<E>
const defects = cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) // Array<unknown>

const interruptedOnly = Cause.hasInterruptsOnly(cause)
const hasAnyInterrupt = Cause.hasInterrupts(cause)
```

If the no-defect branch needs the remaining cause, keep the `Result` instead of converting it:

```ts
const defect = Cause.findDefect(cause)

const rendered = Result.match(defect, {
  onSuccess: (value) => renderDefect(value),
  onFailure: (remainingCause) => renderCause(remainingCause),
})
```

## Migration table

| v3                        | v4                                                       | Shape                |
| ------------------------- | -------------------------------------------------------- | -------------------- |
| recursive `Cause` tree    | `cause.reasons`                                          | flat ordered array   |
| `Cause.failureOption`     | `Cause.findErrorOption`                                  | `Option` retained    |
| `Cause.dieOption`         | `Cause.findDefect`                                       | `Option` to `Result` |
| `Cause.failures`          | filter `reasons` with `Cause.isFailReason`, map `.error` | `Chunk` to `Array`   |
| `Cause.defects`           | filter `reasons` with `Cause.isDieReason`, map `.defect` | `Chunk` to `Array`   |
| `Cause.isInterruptedOnly` | `Cause.hasInterruptsOnly`                                | rename               |
| `Cause.isInterrupted`     | `Cause.hasInterrupts`                                    | rename               |

## Equivalence

All named v4 exports, the `Cause.reasons` representation, reason fields, and the
`findDefect` result type were verified directly in the `effect@4.0.0-beta.102` tarball
(SHA-1 `f51092854960f60cbdb06bd59e788acbc8ee8492`). This recipe does not replace a
slice's differential proof.

For each migrated site, compare the ordered extracted failure/defect values, interruption
classification, empty-cause handling, and encoded output for mixed causes. A value-only assertion
is insufficient at serialization boundaries.

## Intended differences (alignment register entries)

None for source inspection. The existing `rpc-failure-cause-wire-shape` entry concerns serialized
RPC failure envelopes only. It does not cover this source migration or authorize a different
extractor result, collection type, ordering, or traversal behavior.

## Gotchas

- Do not pass `Cause.findDefect(cause)` to `Option.match`; it is a `Result`. Use
  `Result.getSuccess` only when intentionally discarding the unmatched cause.
- Remove `Chunk.toReadonlyArray` and other `Chunk` combinators after replacing
  `failures`/`defects`; the filtered values are already arrays.
- Filter before reading `.error` or `.defect`. A `Reason` is a union and mixed causes are valid.
- A flat reason scan preserves reason order, but it cannot preserve assumptions about v3
  sequential/parallel tree topology. Any topology-sensitive formatter or serializer needs its own
  behavioral proof.

## Codemod rule

Only the interruption predicates and `failureOption` rename mechanically. `dieOption`,
`failures`, `defects`, and every direct recursive traversal require site review because their
result or representation shape changed.
