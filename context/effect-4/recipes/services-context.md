# Pattern: services-context

**Area:** Services and Layers **Kind:** semantic **Our usage:** service definitions occur in
14 packages; the densest slices are `restate-effect`, `utils`, `megarepo`, and Notion packages.

## v3

```ts
class Greeter extends Effect.Service<Greeter>()('Greeter', {
  accessors: true,
  dependencies: [Prefix.Default],
  effect: Effect.gen(function* () {
    const prefix = yield* Prefix
    return { greet: (name: string) => Effect.succeed(`${prefix.value}, ${name}`) }
  }),
}) {}

const result = yield * Greeter.greet('Ada')
const program = effect.pipe(Effect.provide(Greeter.Default))
```

## v4

```ts
class Greeter extends Context.Service<Greeter>()('Greeter', {
  make: Effect.gen(function* () {
    const prefix = yield* Prefix
    return { greet: (name: string) => Effect.succeed(`${prefix.value}, ${name}`) }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Prefix.layer))
}

const result = yield * Greeter.use((greeter) => greeter.greet('Ada'))
const program = effect.pipe(Effect.provide(Greeter.layer))
```

## Equivalence

```sh
bun run run services-context
```

Result: **IDENTICAL**. The explicit v4 layer constructs the service once, resolves its dependency
before both calls, and produces the same ordered results as v3's generated `.Default` layer.

## Intended differences (alignment register entries)

None. The migration should preserve construction count and resolution order.

## Gotchas

- v4 removes generated accessor proxies. Rewrite `Service.method(args)` to
  `Service.use((service) => service.method(args))`, or preferably yield the service once.
- `dependencies` and generated `.Default` layers are gone. Each dependency must be wired into an
  explicit `Layer.effect(Service, Service.make)`.
- Do not replace an old `.Default` layer with `Layer.effect` alone: that leaves constructor
  dependencies in the layer input and shifts failures to integration.
- Preserve layer sharing/freshness decisions separately; v4 layer memoization has its own
  differential pattern.

## Codemod rule

No general codemod. The class header and option names are mechanical, but layer dependency wiring
and accessor call-site rewrites are semantic and must be reviewed with the service's constructor.
