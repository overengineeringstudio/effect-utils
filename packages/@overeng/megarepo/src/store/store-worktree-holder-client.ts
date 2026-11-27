import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { HolderEvidenceError, HolderEvidenceResponse } from './store-worktree-holder-codec.ts'

const refused = () => new HolderEvidenceError({})

/** Recheck immediately before the consumer's final action. This is not a lease or exclusion. */
export const assertWorktreeHolderEvidenceFresh = (
  response: HolderEvidenceResponse,
): Effect.Effect<void, HolderEvidenceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* Schema.decodeEffect(HolderEvidenceResponse)(response)
    if (
      !response.scope.complete ||
      !response.scope.allUids ||
      !response.scope.allTasks ||
      response.roots.some(
        (root) =>
          !root.complete ||
          !root.referencesComplete ||
          root.status === 'unknown' ||
          root.identity === null ||
          root.unknownReasons.length !== 0,
      )
    ) {
      return yield* refused()
    }
    const fs = yield* FileSystem.FileSystem
    const boot = (yield* fs.readFileString('/proc/sys/kernel/random/boot_id')).trim()
    const uptime = yield* fs.readFileString('/proc/uptime')
    const match = /^(0|[1-9][0-9]*)\.([0-9]{2}) [0-9]+\.[0-9]{2}\n?$/u.exec(uptime)
    if (boot !== response.bootId || match === null) return yield* refused()
    // /proc/uptime truncates CLOCK_BOOTTIME to centiseconds. Use the upper bound.
    const now = BigInt(match[1]!) * 1_000_000_000n + BigInt(match[2]!) * 10_000_000n + 10_000_000n
    const { startedBootNs, finishedBootNs, expiresBootNs } = response.capture
    if (
      BigInt(startedBootNs) > BigInt(finishedBootNs) ||
      BigInt(finishedBootNs) > now ||
      BigInt(expiresBootNs) <= BigInt(finishedBootNs) ||
      BigInt(expiresBootNs) - BigInt(startedBootNs) !== 30_000_000_000n ||
      now >= BigInt(expiresBootNs)
    )
      return yield* refused()
  }).pipe(Effect.mapError(refused))
