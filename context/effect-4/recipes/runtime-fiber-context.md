# Pattern: runtime-fiber-context

**Area:** Runtime and FiberRef **Kind:** semantic **Our usage:** runtime calls are concentrated in
`restate-effect` (30 lexical sites), `effect-react` (11), and `tui-react` (11); the custom
FiberRef is localized to `utils`.

## v3

```ts
const Local = FiberRef.unsafeMake('default')

const runtime = yield * Effect.runtime<AppServices>()
const fiber = Runtime.runFork(runtime)(program)

const child = yield * Effect.fork(program.pipe(Effect.locally(Local, 'child')))
```

## v4

```ts
const Local = Context.Reference('Local', {
  defaultValue: () => 'default',
})

const services = yield * Effect.context<AppServices>()
const fiber = Effect.runForkWith(services)(program)

const child = yield * Effect.forkChild(program.pipe(Effect.provideService(Local, 'child')))
```

## Equivalence

```sh
bun run run runtime-fiber-context
```

Result: **IDENTICAL**. The captured v4 Context carries both the required service and the current
Reference value into `runForkWith`. A child-local override is observed by the child and does not
leak back into the parent, matching the v3 Runtime/FiberRef behavior.

## Intended differences (alignment register entries)

None for the covered capture/fork/override flow.

## Gotchas

- `Runtime.Runtime<R>` is removed; storing a runtime in application state becomes storing
  `Context.Context<R>`, and every runner call changes from `Runtime.runFork(runtime)` to
  `Effect.runForkWith(context)`.
- A v3 Runtime snapshot included runtime flags and FiberRefs. The replacement Context must be
  captured inside all required service/Reference provisions; an empty or prematurely captured
  Context silently loses overrides.
- `FiberRef.set` has no direct mutation-style replacement. Restructure the remaining computation
  under `Effect.provideService(Reference, value)`.
- v4 `Effect.fork` was renamed to `forkChild`; do not accidentally choose detached lifetime
  semantics while performing the runtime rewrite.

## Codemod rule

No general codemod. Import/name rewrites are mechanical, but moving FiberRef mutation into a
lexically scoped provider changes program structure and must be reviewed at each site.
