import { NodeRuntime } from '@effect/platform-node'
import { Effect, Option, Schema } from 'effect'

import { makeOtelCliLayer, ServiceIdentity } from '../otel.ts'

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'delivery-cli',
  namespace: 'overeng.test',
  version: '1.0.0',
})

Effect.gen(function* () {
  yield* Effect.sync(() => process.stdout.write('{"ok":true}\n'))
  if (process.argv[4] === 'fail') return yield* Effect.fail('domain-failure')
}).pipe(
  Effect.withSpan('delivery-root', { root: true, attributes: { 'span.label': 'delivery' } }),
  Effect.provide(
    makeOtelCliLayer({
      identity,
      endpoint: Option.some(process.argv[2]!),
      exportInterval: 60_000,
      shutdownTimeout: Number(process.argv[3]),
    }),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
