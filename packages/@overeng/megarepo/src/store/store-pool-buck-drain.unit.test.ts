import { describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { expect } from 'vitest'

import {
  type BuckDaemonIdentity,
  type BuckDaemonResult,
  type BuckDaemonStopped,
} from './store-buck-daemons.ts'
import { requirePoolBuckDrain } from './store-pool-buck.ts'

// Synthetic receipt metadata only: passing this veto never proves a native stop or all-UID quiescence.
const identity: BuckDaemonIdentity = {
  pid: 101,
  daemonId: 'metadata-only',
  isolation: 'v2',
  root: '/metadata-only-slot',
  path: '/metadata-only-runtime',
}
const stopped: BuckDaemonStopped = { _tag: 'stopped', ...identity, freedKiB: 1 }

describe('pool Buck shutdown receipt veto', () => {
  it.effect(
    'does not veto empty discovery or an unraced stopped receipt, without granting authority',
    () =>
      Effect.gen(function* () {
        expect(Exit.isSuccess(yield* Effect.exit(requirePoolBuckDrain([])))).toBe(true)
        expect(Exit.isSuccess(yield* Effect.exit(requirePoolBuckDrain([stopped])))).toBe(true)
      }),
  )

  for (const raced of [
    'kill-stopped-other-pid-202',
    'command-log-written-during-kill',
    '',
    'unknown-race',
  ]) {
    it.effect(`refuses a stopped receipt carrying raced metadata: ${JSON.stringify(raced)}`, () =>
      Effect.gen(function* () {
        const error = yield* requirePoolBuckDrain([stopped, { ...stopped, raced }]).pipe(
          Effect.flip,
        )
        expect(error.message).toBe(
          'Pool prewarm Buck shutdown is active, unreachable or raced; HOLD',
        )
      }),
    )
  }

  const blocked: ReadonlyArray<BuckDaemonResult> = [
    { _tag: 'kept-active', ...identity },
    { _tag: 'unreachable', ...identity, memoryKiB: 1, reason: 'metadata-only-status-unavailable' },
  ]
  for (const outcome of blocked) {
    it.effect(`refuses a mixed batch containing ${outcome._tag}`, () =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(requirePoolBuckDrain([stopped, outcome])))).toBe(
          true,
        )
      }),
    )
  }
})
