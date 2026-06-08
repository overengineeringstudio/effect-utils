/**
 * A stateless Service, end-to-end: contract → implement → endpoint → typed
 * ingress call, including the typed error boundary.
 *
 * Every binding in this file is exercised by `src/examples.integration.test.ts`
 * against a real native `restate-server` (so the example is verified, not just
 * type-checked). See `README.md` § "A first Service".
 */
import { Context, Effect, Layer, Schema } from 'effect'

import { Restate, RestateService } from '../src/mod.ts'

/* ── 1. The application service the handler depends on (ordinary Effect) ──── */

/** An injected greeting prefix — satisfied from the application Layer, not per call. */
export class Greeting extends Context.Tag('example/Greeting')<
  Greeting,
  { readonly prefix: string }
>() {
  static readonly Default = Layer.succeed(Greeting, { prefix: 'Hello' })
}

/* ── 2. The Schemas: input, success, and the one declared business error ──── */

export const GreetInput = Schema.Struct({ name: Schema.String })
export const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })

/** A declared business failure. It crosses the wire as a terminal error and
 * decodes back into THIS tagged error on the caller side (the typed boundary). */
export class EmptyName extends Schema.TaggedError<EmptyName>('example/EmptyName')(
  'EmptyName',
  {},
) {}

/* ── 3. The contract: handler names + their I/O/error Schemas (shareable) ─── */

export const Greeter = RestateService.contract('greeter', {
  greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
})

/* ── 4. The implementation: bind each handler name to an Effect ───────────── */

/* `AppR` (`Greeting`) is passed EXPLICITLY — it is the residual requirement the
 * application Layer satisfies. The handler `E` channel carries ONLY `EmptyName`. */
export const GreeterLive = RestateService.implement<typeof Greeter, Greeting>(Greeter, {
  greet: ({ name }) =>
    Effect.gen(function* () {
      if (name === '') return yield* new EmptyName()
      const { prefix } = yield* Greeting
      /* A non-deterministic call (a UUID) journaled once by `Restate.run`, so a
       * replay observes the SAME id. A failed durable step is infrastructure →
       * `orDie`, keeping the wrapper error out of the `EmptyName`-only `E`. */
      const id = yield* Restate.run(
        'gen-id',
        Effect.sync(() => crypto.randomUUID()),
      ).pipe(Effect.orDie)
      return { message: `${prefix} ${name}`, id }
    }),
})

/* `GreeterLive` is served by the endpoint `layer`/`serve` (see `04-endpoint.ts`)
 * with `Greeting.Default` provided as the application Layer. */
