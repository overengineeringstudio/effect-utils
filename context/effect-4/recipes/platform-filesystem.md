# Pattern: platform-filesystem

**Area:** Platform  **Kind:** semantic  **Our usage:** the platform family has 183 imports; process
and filesystem-heavy packages include `agent-session-ingest`, `megarepo`, `restate-effect`,
`ci-tools`, `effect-path`, and `utils`.

## v3

```ts
import { FileSystem, Path } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"

const fs = yield* FileSystem.FileSystem
const path = yield* Path.Path
const program = effect.pipe(Effect.provide(NodeContext.layer))
```

## v4

```ts
import { FileSystem, Path } from "effect"
import { NodeServices } from "@effect/platform-node"

const fs = yield* FileSystem.FileSystem
const path = yield* Path.Path
const program = effect.pipe(Effect.provide(NodeServices.layer))
```

## Equivalence

```sh
bun run run platform-filesystem
```

The probe compares path operations, write/read/stat bytes, and normalized ENOENT, EEXIST, and
EACCES error fields. Result: **ALLOWLISTED, 3 exact paths, 0 unexpected**. All successful
operations are identical. Each failure preserves reason, module, and method; only the outer tag
changes from v3 `SystemError` to v4 `PlatformError`.

## Intended differences (alignment register entries)

- `platform-error-wrapper`: accept the deliberate v4 outer wrapper, but rewrite every old
  `_tag === "SystemError"` / `catchTag("SystemError")` branch to match `PlatformError` and inspect
  its reason. The inner ENOENT/EEXIST/EACCES taxonomy is unchanged in this probe.

## Gotchas

- v4 wraps platform failures in `PlatformError`; old `_tag`/reason matching must move through the
  wrapper or use `instanceof`.
- `Path` is a mechanical import move, but it normally arrives through a platform context whose
  composition changed from `NodeContext.layer` to `NodeServices.layer`.
- This probe uses deterministic local read/write/stat operations. Watch event ordering is
  **NOT COVERED** and needs a package-level gate where watchers are used.

## Codemod rule

`import { Path } from "@effect/platform"` may become `import { Path } from "effect"` when it is the
only imported platform symbol. FileSystem provider and error-handler rewrites are semantic.
