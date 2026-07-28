# Pattern: platform-child-process

**Area:** Platform / process **Kind:** semantic **Our usage:** process and command APIs are
load-bearing in `utils`, `megarepo`, `ci-tools`, `agent-session-ingest`, and integration tests.

## v3

```ts
import { Command, CommandExecutor } from '@effect/platform'

const executor = yield * CommandExecutor.CommandExecutor
const child = yield * executor.start(Command.make('tool', ...args))
const code = yield * child.exitCode
```

## v4

```ts
import { ChildProcess } from 'effect/unstable/process'

const child = yield * ChildProcess.make('tool', args)
const code = yield * child.exitCode
```

## Equivalence

```sh
bun run run platform-child-process
```

The probe compares a non-zero exit with exact stdout/stderr streams and an explicit SIGTERM flow
with a trapped exit/status. Result: **IDENTICAL**. Both versions preserve exit `7`, separate
stdout/stderr bytes, SIGTERM delivery, trapped exit `23`, and termination stderr.

## Intended differences (alignment register entries)

None expected: API construction changes should not change process bytes, exit codes, or signal
behavior.

## Gotchas

- v4 commands are directly Effectable and require a Scope; do not retain a handle outside the
  scope that owns the process.
- Constructor options are flattened. Translate cwd/env/shell/stdin/stdout/stderr at construction,
  not by searching for one-to-one post-construction combinators.
- Collect stdout and stderr concurrently with exit status or a child can block on a full pipe.
- The two streams are compared separately. Cross-stream wall-clock interleaving is platform
  scheduling and is not asserted by this deterministic probe.
- `Terminal` input/rendering and interactive PTY behavior are **NOT COVERED**; they require a
  deterministic pseudo-terminal fixture. Large-output backpressure and chunk boundaries are also
  **NOT COVERED** by the small exact-byte streams here.

## Codemod rule

No general codemod. `Command.make(name, ...args)` becomes
`ChildProcess.make(name, args, options)`, but executor access, scope ownership, stream collection,
and kill options require semantic repair.
