# Pattern: layer-clock-providers

**Area:** Layer, Clock, Random, and ConfigProvider construction **Kind:** semantic **Our usage:**
Layer has 31 affected sites across 23 files and 8 packages; Clock has 13 sites across 6 files and
3 packages; `ConfigProvider.fromMap` has 5 sites across 3 files. The measured Layer/Clock package
heatmap includes `megarepo`, `tui-react`, `notion-datasource-sync`, `utils`, `restate-effect`,
`notion-md`, `notion-effect-client`, `utils-dev`, and `effect-distributed-lock`.

## Shape changes first

- v4 has no separate scoped Layer constructors. `Layer.effect` and `Layer.effectDiscard` own the
  layer scope and exclude `Scope.Scope` from their requirements.
- `Layer.map` is removed. Transform a produced `Context` with `Layer.flatMap`, then lift the
  replacement `Context` with `Layer.succeedContext`.
- Clock, Random, and ConfigProvider are `Context.Reference`s. Their old `Layer.set*` constructors
  become ordinary Reference layers.
- `Clock.make` is removed. The live implementation is the default value of the `Clock.Clock`
  Reference, and custom implementations use renamed unsafe methods.
- `ConfigProvider.fromUnknown` walks an object hierarchy. It does not split delimiters embedded
  in object keys as v3 `fromMap` did.

## Layer constructors

### v3

```ts
const serviceLayer = Layer.scoped(Service, acquireService)
const startupLayer = Layer.scopedDiscard(startup)

const selected = Layer.unwrapEffect(selectLayer)
const selectedScoped = Layer.unwrapScoped(selectLayerScoped)

const projected = Layer.map(sourceLayer, (context) => projectContext(context))
```

### v4

```ts
const serviceLayer = Layer.effect(Service, acquireService)
const startupLayer = Layer.effectDiscard(startup)

const selected = Layer.unwrap(selectLayer)
const selectedScoped = Layer.unwrap(selectLayerScoped)

const projected = sourceLayer.pipe(
  Layer.flatMap((context) => Layer.succeedContext(projectContext(context))),
)
```

| v3                            | v4 restructuring                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `Layer.scoped`                | `Layer.effect`                                                                   |
| `Layer.scopedDiscard`         | `Layer.effectDiscard`                                                            |
| `Layer.unwrapEffect`          | `Layer.unwrap`                                                                   |
| `Layer.unwrapScoped`          | `Layer.unwrap`                                                                   |
| `Layer.map(layer, transform)` | `layer.pipe(Layer.flatMap(context => Layer.succeedContext(transform(context))))` |

## Reference layers

### v3

```ts
const runtimeOverrides = Layer.mergeAll(
  Layer.setClock(customClock),
  Layer.setRandom(customRandom),
  Layer.setConfigProvider(configProvider),
)
```

### v4

```ts
const runtimeOverrides = Layer.mergeAll(
  Layer.succeed(Clock.Clock, customClock),
  Layer.succeed(Random.Random, customRandom),
  ConfigProvider.layer(configProvider),
)
```

The v4 Random service shape is the primitive generator, not the v3 effectful facade:

```ts
const deterministicRandom = Layer.succeed(Random.Random, {
  nextIntUnsafe: () => 4,
  nextDoubleUnsafe: () => 0.25,
})
```

Callers continue to use effectful operations such as `Random.next`, `Random.nextInt`, and
`Random.shuffle`; those operations derive from the two Reference methods. Effect 3 call sites of
`Random.nextIntBetween(min, max)` must pass `{ halfOpen: true }` in v4 to preserve the exclusive
upper bound; see `random-bounds-semantics.md`.

## Custom Clock

### v3

```ts
const liveClock = Clock.make()

const fixedClock: Clock.Clock = {
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  unsafeCurrentTimeMillis: () => nowMillis,
  currentTimeMillis: Effect.succeed(nowMillis),
  unsafeCurrentTimeNanos: () => BigInt(nowMillis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(nowMillis) * 1_000_000n),
  sleep: (duration) => liveClock.sleep(duration),
}
```

### v4

```ts
const liveClock = Clock.Clock.defaultValue()

const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => nowMillis,
  currentTimeMillis: Effect.succeed(nowMillis),
  currentTimeNanosUnsafe: () => BigInt(nowMillis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(nowMillis) * 1_000_000n),
  sleep: (duration) => liveClock.sleep(duration),
}

const fixedClockLayer = Layer.succeed(Clock.Clock, fixedClock)
```

`Clock.ClockTypeId` and its brand are gone. The unsafe names move the `Unsafe` suffix to the end:
`unsafeCurrentTimeMillis` becomes `currentTimeMillisUnsafe`, and
`unsafeCurrentTimeNanos` becomes `currentTimeNanosUnsafe`.

## ConfigProvider

For the repository's flat, already-complete keys, construct the object explicitly and install it
with the provider's layer:

```ts
const provider = ConfigProvider.fromUnknown({
  RESTATE_ADMIN_URL: 'http://admin.local:9070',
  RESTATE_ADMIN_KEY: 'k3y',
})

const configLayer = ConfigProvider.layer(provider)
```

When a v3 map encoded path segments with `pathDelim`, expand those keys into the matching object
hierarchy before calling `fromUnknown`:

```ts
// v3: fromMap(new Map([["database_host", "localhost"]]), { pathDelim: "_" })
const provider = ConfigProvider.fromUnknown({
  database: {
    host: 'localhost',
  },
})
```

Do not migrate that example to `{ database_host: "localhost" }`: a config lookup for
`["database", "host"]` would miss at runtime.

## Equivalence

All v4 constructors, Reference shapes, Clock method names, and ConfigProvider behavior named here
were verified directly in the `effect@4.0.0-beta.102` tarball (SHA-1
`f51092854960f60cbdb06bd59e788acbc8ee8492`). The legacy constructors were also confirmed absent.
This recipe does not replace a slice's differential proof.

For Layer sites, compare acquisition/finalization counts and order, output services, and failures
under interruption. For Clock/Random sites, compare every consumed value and sleep behavior. For
ConfigProvider sites, probe flat keys, nested paths, missing keys, and empty strings used by that
slice.

## Intended differences (alignment register entries)

None for these constructor forms. The layer-memoization recipe separately governs v4's sharing
change; this recipe does not alter that decision. Neither that recipe nor `services-context`
documents the constructor replacements covered here.

## Gotchas

- Do not replace `Layer.map` with `Layer.flatMap((context) => projectContext(context))` directly:
  `flatMap` must return a `Layer`, so lift the projected `Context` with `Layer.succeedContext`.
- Preserve scoped acquisition and finalization when renaming `scoped`/`scopedDiscard`. Green
  construction alone does not prove finalizers still run.
- Do not implement a custom Clock by spreading `Clock.Clock.defaultValue()`: its unsafe and
  `sleep` methods live on the prototype. Delegate explicitly or retain the prototype.
- Do not implement custom Clock `sleep` as `Effect.sleep(duration)` while that same Clock is
  installed; it resolves the installed Clock again. Delegate to a captured live Clock.
- A v3 custom Random object cannot be installed unchanged. Implement the v4 Reference's
  `nextIntUnsafe` and `nextDoubleUnsafe` primitives and prove the derived sequence used by the
  slice.
- The v4 default for `Random.nextIntBetween` includes the upper bound. Preserve v3 semantics with
  `{ halfOpen: true }`; a mid-range-only test does not detect this breakage.
- `ConfigProvider.fromUnknown` treats empty strings as missing unless
  `{ preserveEmptyStrings: true }` is passed.

## Codemod rule

The scoped/unwrap names can be rewritten mechanically only after their effect types still include
the intended scope. `Layer.map`, every Reference layer, custom Clock/Random implementations, and
delimited `fromMap` inputs require site review and differential proof.
