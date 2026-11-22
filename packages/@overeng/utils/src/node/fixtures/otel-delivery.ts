import { NodeRuntime } from '@effect/platform-node'
import { Effect, Option, Schema } from 'effect'

import { OtelAttr, OtelOperation } from '@overeng/otel-contract'

import { makeOtelCliLayer, ServiceIdentity } from '../otel.ts'

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'delivery-cli',
  namespace: 'overeng.test',
  version: '1.0.0',
})

const DeliveryOperation = OtelOperation.define({
  name: 'delivery-root',
  schema: Schema.Struct({
    label: OtelAttr.drop(Schema.NonEmptyString),
  }),
  label: ({ label }) => label,
})

Effect.gen(function* () {
  yield* Effect.sync(() => process.stdout.write('{"ok":true}\n'))
  if (process.argv[4] === 'fail') return yield* Effect.fail('domain-failure')
}).pipe(
  DeliveryOperation.withRoot({ label: 'delivery' }),
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
