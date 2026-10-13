import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import * as TestClock from 'effect/testing/TestClock'

import { scenario } from './scenario.ts'

/** Log the deterministic scenario transcript, not runtime log metadata. */
scenario().pipe(
  Effect.tap((lines) =>
    Effect.sync(() => {
      for (const line of lines) console.log(line)
    }),
  ),
  Effect.provide(TestClock.layer()),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)
