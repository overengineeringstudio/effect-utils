# Pattern: schedule-composition-metadata

**Area:** Retry/repeat scheduling **Kind:** shape change **Our usage:** `megarepo` git retries and
retry metadata logging, plus schedule composition in Notion and release packages.

## Shape changes first

- V3 `Schedule.intersect(A, B)` continued only while both schedules recurred, waited for the longer
  delay, and output `[AOutput, BOutput]`.
- V4 `Schedule.max([A, B])` preserves the continuation and maximum-delay behavior but outputs the
  selected `Duration`, not the tuple.
- `Schedule.CurrentIterationMetadata` becomes `Schedule.CurrentMetadata`.
- Metadata `recurrence` becomes `attempt`.
- V3 `elapsed` / `elapsedSincePrevious` were `Duration`; v4 stores their millisecond values as
  `number`.

## Git retry replacement

The repository's git retry does not consume the composed schedule output, so its faithful
replacement is:

```ts
// v3
const retry = Schedule.exponential('2 seconds').pipe(
  Schedule.intersect(Schedule.recurs(GIT_MAX_RETRIES)),
)

// v4
const retry = Schedule.max([Schedule.exponential('2 seconds'), Schedule.recurs(GIT_MAX_RETRIES)])
```

Metadata logging becomes:

```ts
const metadata = yield * Schedule.CurrentMetadata

if (metadata.attempt > 0) {
  yield *
    Effect.logWarning('Retrying').pipe(
      Effect.annotateLogs({
        attempt: metadata.attempt,
        elapsed: Duration.format(Duration.millis(metadata.elapsed)),
        error: String(metadata.input),
      }),
    )
}
```

## Equivalence

All APIs and metadata shapes are **VERIFIED** against the real beta.102 tarball. A direct
cross-major retry probe used exponential delay plus a three-retry cap. Both traces were:

```text
attempt 0, input absent
attempt 1, input first failure
attempt 2, input second failure
attempt 3, input third failure
success on the fourth execution
```

This establishes the replacement for the repository's output-discarding retry schedule. Owning
slices must additionally assert their real delay sequence, retry cap, `while` classification, and
logged metadata.

## Output-shape trap

`Schedule.max` is not a complete replacement when the v3 tuple output is consumed. It emits only a
`Duration`. Such sites need an explicit `Schedule.fromStep` composition or a redesigned output
projection, with a behavior probe. Do not cast the duration to the old tuple or silently discard an
output used by retry logic.

## Intended differences

None for the git retry continuation, delay, cap, and metadata behavior. The schedule's unused output
shape may narrow to `Duration`; consumed tuple outputs require separate adjudication.

## Gotchas

- `Schedule.min` has the opposite continuation/delay semantics: it continues while any schedule
  recurs and picks the fastest delay. It is not the replacement for v3 `intersect`.
- `metadata.elapsed` is a number of milliseconds; wrapping it with `Duration.millis` preserves
  v3 `Duration.format` call sites.
- Retry attempt zero has no previous failure input. Do not read/cast `metadata.input` before
  checking `attempt > 0`.

## Codemod rule

Only output-discarding `intersect` sites may mechanically become `max([A, B])`. Metadata names and
elapsed units then require the explicit rewrites above.
