import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'

import type { ExemptProcess } from './store-inuse.ts'
import { PinnedDeletionError, withPinnedDeletion } from './store-pinned-deletion.ts'

/** Append-only audit history; GC never compacts or removes deletion receipts. */
export const GC_DELETION_RECEIPTS_RELATIVE_PATH = '.state/gc-deletions.jsonl'

/** Durable per-attempt deletion decision and recovery evidence. */
export const GcDeletionReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('megarepo.gc-deletion.v1'),
  attemptId: Schema.String,
  time: Schema.Finite,
  path: Schema.String,
  phase: Schema.Literals(['intent', 'outcome']),
  decision: Schema.Literals(['remove', 'removed', 'partial', 'skipped-in-use', 'error']),
  reason: Schema.String,
  vetoEvidence: Schema.Array(Schema.Struct({ pid: Schema.Int, path: Schema.String })),
  ignoredForeignProcesses: Schema.optional(Schema.Int),
  exemptProcesses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        pid: Schema.Int,
        startTime: Schema.String,
        comm: Schema.String,
        rule: Schema.Literals([
          'systemd-user-manager',
          'systemd-user-pam',
          'sshd-privilege-transition',
        ]),
      }),
    ),
  ),
  errno: Schema.optional(Schema.String),
  recoverPath: Schema.optional(Schema.String),
})

const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(GcDeletionReceipt))
type Receipt = typeof GcDeletionReceipt.Type

/** One O_APPEND write per record plus fsync of both file and containing directory. */
export const recordGcDeletion = Effect.fn('store.recordGcDeletion')(function* ({
  storeBasePath,
  ...receipt
}: Omit<Receipt, 'schemaVersion' | 'time' | 'attemptId'> & {
  storeBasePath: string
  attemptId?: string
}) {
  yield* Effect.try({
    try: () => {
      const directory = join(storeBasePath, '.state')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const fd = openSync(
        join(storeBasePath, GC_DELETION_RECEIPTS_RELATIVE_PATH),
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const line = Buffer.from(
          `${encodeReceipt({
            ...receipt,
            schemaVersion: 'megarepo.gc-deletion.v1',
            attemptId: receipt.attemptId ?? randomUUID(),
            ignoredForeignProcesses: receipt.ignoredForeignProcesses ?? 0,
            exemptProcesses: receipt.exemptProcesses ?? [],
            time: Date.now(),
          })}\n`,
        )
        if (writeSync(fd, line) !== line.length) {
          throw new PinnedDeletionError({ path: receipt.path, message: 'Short GC receipt write' })
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // Sync the store too: the first append may have created its .state entry.
      for (const directoryPath of [directory, storeBasePath]) {
        const directoryFd = openSync(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY)
        try {
          fsyncSync(directoryFd)
        } finally {
          closeSync(directoryFd)
        }
      }
    },
    catch: (cause) =>
      new PinnedDeletionError({
        path: receipt.path,
        message: 'GC deletion receipt could not be persisted',
        cause,
        ...(cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
          ? { code: cause.code }
          : {}),
      }),
  })
})

/** Persist intent before invoking any mutation; persist its outcome before returning to the CLI. */
export const withGcDeletionReceipt = <TValue, TError, TRequirements>({
  storeBasePath,
  path,
  reason,
  effect,
  ignoredForeignProcesses,
  exemptProcesses,
}: {
  storeBasePath: string
  path: string
  reason: string
  effect: Effect.Effect<TValue, TError, TRequirements>
  ignoredForeignProcesses?: number | (() => number | undefined) | undefined
  exemptProcesses?:
    | ReadonlyArray<ExemptProcess>
    | (() => ReadonlyArray<ExemptProcess> | undefined)
    | undefined
}): Effect.Effect<TValue, TError | PinnedDeletionError, TRequirements> =>
  Effect.gen(function* () {
    const attemptId = randomUUID()
    const base = () => ({
      storeBasePath,
      attemptId,
      path,
      reason,
      vetoEvidence: [],
      ignoredForeignProcesses:
        typeof ignoredForeignProcesses === 'function'
          ? (ignoredForeignProcesses() ?? 0)
          : (ignoredForeignProcesses ?? 0),
      exemptProcesses:
        typeof exemptProcesses === 'function' ? (exemptProcesses() ?? []) : (exemptProcesses ?? []),
    })
    yield* recordGcDeletion({ ...base(), phase: 'intent', decision: 'remove' })
    return yield* effect.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          recordGcDeletion({
            ...base(),
            phase: 'outcome',
            decision:
              error instanceof PinnedDeletionError && error.partial === true ? 'partial' : 'error',
            reason: error instanceof Error ? error.message : String(error),
            ...(error instanceof PinnedDeletionError && error.code !== undefined
              ? { errno: error.code }
              : {}),
            ...(error instanceof PinnedDeletionError && error.recoverPath !== undefined
              ? { recoverPath: error.recoverPath }
              : {}),
          }).pipe(
            Effect.mapError((receiptError) =>
              error instanceof PinnedDeletionError && error.partial === true
                ? new PinnedDeletionError({
                    path: error.path,
                    message: `${error.message}; outcome receipt could not be persisted`,
                    cause: receiptError,
                    partial: true,
                    ...(error.code === undefined ? {} : { code: error.code }),
                    ...(error.recoverPath === undefined ? {} : { recoverPath: error.recoverPath }),
                  })
                : receiptError,
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        onSuccess: (value) =>
          recordGcDeletion({ ...base(), phase: 'outcome', decision: 'removed' }).pipe(
            Effect.mapError(
              (error) =>
                new PinnedDeletionError({
                  path,
                  message: 'Deletion completed but its outcome receipt could not be persisted',
                  cause: error,
                  partial: true,
                  ...(error.code === undefined ? {} : { code: error.code }),
                }),
            ),
            Effect.as(value),
          ),
      }),
    )
  })

/** The audited deletion boundary shared by every GC fd-pinned deletion site. */
export const withGcPinnedDeletion = <TError = never, TRequirements = never>(
  options: Parameters<typeof withPinnedDeletion<TError, TRequirements>>[0] & {
    ignoredForeignProcesses?: number | (() => number | undefined) | undefined
    exemptProcesses?:
      | ReadonlyArray<ExemptProcess>
      | (() => ReadonlyArray<ExemptProcess> | undefined)
      | undefined
  },
) => {
  let recoverPath: string | undefined
  const { ignoredForeignProcesses, exemptProcesses, ...deletion } = options
  return withGcDeletionReceipt({
    storeBasePath: options.rootPath,
    path: options.path,
    reason: 'gc',
    ignoredForeignProcesses,
    exemptProcesses,
    effect: withPinnedDeletion({
      ...deletion,
      afterQuarantine: (path) => {
        recoverPath = path
        options.afterQuarantine?.(path)
      },
    }),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof PinnedDeletionError &&
      error.partial === true &&
      error.recoverPath === undefined &&
      recoverPath !== undefined
        ? new PinnedDeletionError({
            path: error.path,
            message: error.message,
            cause: error,
            partial: true,
            recoverPath,
            ...(error.code === undefined ? {} : { code: error.code }),
          })
        : error,
    ),
  )
}
