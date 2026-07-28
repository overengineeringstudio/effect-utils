# Pattern: effect-never-idle

**Area:** Runtime / process lifetime **Kind:** semantic **Our usage:** long-lived workers in
`pty-effect`, `restate-effect`, and `agent-session-ingest`.

## v3

```ts
const fiber = Effect.runFork(Effect.never)
```

Effect 3 implements `Effect.never` with a `2 ** 31 - 1` millisecond interval and clears it on
interruption.

## v4

```ts
const fiber = Effect.runFork(Effect.never)
```

The source is unchanged, but Effect 4 parks the fiber without registering a timer.

## Equivalence

```sh
bun run run:pattern effect-never-idle
```

ALLOWLISTED: the v3 trace reports one interval and v4 reports zero. Both fibers remain suspended
until interrupted.

## Intended differences (alignment register entries)

- v4 no longer keeps the host alive with an idle timer — this is an intended runtime improvement —
  accept v4 behavior and make process ownership explicit with the platform main runner or a real
  resource — affects long-lived agent, PTY, and Restate processes.

## Gotchas

- Do not add a synthetic timer to imitate v3. That would undo the hibernation and idle-resource
  improvement.
- If a process relied on `Effect.never` rather than its main runner or an actual server handle to
  stay alive, the lifetime contract was implicit and needs an explicit runtime-level test.
- A unit test that only checks that the fiber is suspended cannot see the host timer difference.

## Codemod rule

None. The source form is identical and the difference is runtime semantics.
