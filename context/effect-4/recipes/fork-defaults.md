# Pattern: fork-defaults

**Area:** Forking and scheduler startup  **Kind:** semantic  **Our usage:** `Effect.fork`,
`forkScoped`, and daemon-like background work appear in process, RPC, Playwright,
TUI, and integration-test code.

## v3

```ts
const fiber = yield* effect.pipe(Effect.fork)
```

## v4

```ts
const fiber = yield* effect.pipe(Effect.forkChild)
```

## Equivalence

Command:

```sh
bun run run fork-defaults
```

Result: default child-fork startup ordering is identical:

```text
before-fork -> after-fork -> child-start -> joined
```

The same probe also includes the copied-options negative control. Adding
`{ startImmediately: true, uninterruptible: "inherit" }` on the v4 side changes
ordering to:

```text
before-fork -> child-start -> after-fork -> joined
```

Those two ordering diffs are allowlisted only to keep this pattern runnable; they
are not approved behaviour changes.

## Intended differences (alignment register entries)

- None for the default migration. The proposed decision is `Effect.fork` ->
  `Effect.forkChild` without copied options unless a call site has its own
  semantic reason.

## Gotchas

- Do not cargo-cult `startImmediately: true` into every migrated fork. The probe
  shows it changes observable ordering.
- `Effect.forkDaemon` maps to `Effect.forkDetach`, but this pattern only proves
  child fork startup order. Detached lifetime still needs a separate probe.
