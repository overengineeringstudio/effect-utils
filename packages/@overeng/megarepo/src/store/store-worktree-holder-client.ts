import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { HolderEvidenceError, HolderEvidenceResponse } from './store-worktree-holder-codec.ts'

const refused = () => new HolderEvidenceError({})

/**
 * Compare a schema-validated capture with one sampled boot-clock interval.
 * @internal
 */
export const holderCaptureFitsBootWindow = ({
  capture,
  lowerBootNs,
  upperBootNs,
}: {
  readonly capture: HolderEvidenceResponse['capture']
  readonly lowerBootNs: bigint
  readonly upperBootNs: bigint
}): boolean => {
  const started = BigInt(capture.startedBootNs)
  const finished = BigInt(capture.finishedBootNs)
  const expires = BigInt(capture.expiresBootNs)
  return (
    started <= finished &&
    finished <= lowerBootNs &&
    expires > finished &&
    expires - started === 30_000_000_000n &&
    upperBootNs < expires
  )
}

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
    // /proc/uptime truncates CLOCK_BOOTTIME to centiseconds.
    const lowerBootNs = BigInt(match[1]!) * 1_000_000_000n + BigInt(match[2]!) * 10_000_000n
    const upperBootNs = lowerBootNs + 10_000_000n
    if (
      holderCaptureFitsBootWindow({ capture: response.capture, lowerBootNs, upperBootNs }) === false
    )
      return yield* refused()
  }).pipe(Effect.mapError(refused))
