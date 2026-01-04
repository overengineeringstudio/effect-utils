import { FileSystem, Path } from '@effect/platform'
import { Cause, Data, Duration, Effect, Layer, Option, Schema, Stream } from 'effect'
import { DistributedSemaphoreBacking, SemaphoreBackingError } from 'effect-distributed-lock'

/** Information about a holder's lock state */
export interface HolderInfo {
  readonly holderId: string
  readonly permits: number
  readonly expiresAt: number
}

/**
 * Schema for individual holder lock files.
 * Each holder gets its own file containing permit count and expiry.
 */
const HolderLockSchema = Schema.Struct({
  /** Number of permits held */
  permits: Schema.Number,
  /** Expiry timestamp in milliseconds since epoch */
  expiresAt: Schema.Number,
})

type HolderLockContent = typeof HolderLockSchema.Type

/**
 * Options for the file-system based semaphore backing.
 */
export interface FileSystemBackingOptions {
  /**
   * Directory where lock files will be stored.
   * Each semaphore key gets its own subdirectory, with one file per holder.
   */
  readonly lockDir: string
}

/** Get the directory path for a semaphore key */
const getKeyDir = (lockDir: string, key: string): string => `${lockDir}/${encodeURIComponent(key)}`

/** Get the file path for a specific holder's lock */
const getHolderPath = (lockDir: string, key: string, holderId: string): string =>
  `${getKeyDir(lockDir, key)}/${encodeURIComponent(holderId)}.lock`

const isNotFoundError = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const record = cause as Record<string, unknown>
  if (record._tag === 'SystemError' && record.reason === 'NotFound') return true
  if (record.code === 'ENOENT') return true
  return false
}

/**
 * Read a holder's lock file, returning undefined if it doesn't exist or is expired.
 */
const readHolderLock = (
  filePath: string,
  now: number,
): Effect.Effect<HolderLockContent | undefined, SemaphoreBackingError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.catchAllCause((cause) => {
        const failure = Option.getOrUndefined(Cause.failureOption(cause))
        if (failure !== undefined && isNotFoundError(failure)) {
          return Effect.succeed(undefined)
        }

        const defect = Option.getOrUndefined(Cause.dieOption(cause))
        if (defect !== undefined && isNotFoundError(defect)) {
          return Effect.succeed(undefined)
        }

        if (failure !== undefined) {
          return Effect.fail(new SemaphoreBackingError({ operation: 'readFile', cause: failure }))
        }
        if (defect !== undefined) {
          return Effect.fail(new SemaphoreBackingError({ operation: 'readFile', cause: defect }))
        }

        return Effect.fail(new SemaphoreBackingError({ operation: 'readFile', cause }))
      }),
    )

    if (content === undefined) {
      return undefined
    }

    const parsed = yield* Schema.decodeUnknown(Schema.parseJson(HolderLockSchema))(content).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(new SemaphoreBackingError({ operation: 'parseJson', cause })),
      ),
    )

    // Check if expired
    if (parsed.expiresAt <= now) {
      // Clean up expired file
      yield* fs.remove(filePath).pipe(Effect.ignore)
      return undefined
    }

    return parsed
  })

/**
 * Write a holder's lock file atomically using write-to-temp-then-rename pattern.
 */
const writeHolderLock = (
  filePath: string,
  content: HolderLockContent,
): Effect.Effect<void, SemaphoreBackingError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const dirPath = path.dirname(filePath)

    yield* fs
      .makeDirectory(dirPath, { recursive: true })
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'makeDirectory', cause })),
        ),
      )

    const json = yield* Schema.encode(Schema.parseJson(HolderLockSchema))(content).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(new SemaphoreBackingError({ operation: 'encodeJson', cause })),
      ),
    )

    // Write to temp file first, then rename for atomicity
    const tempPath = `${filePath}.${Date.now()}.tmp`

    yield* fs
      .writeFileString(tempPath, json)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'writeFile', cause })),
        ),
      )

    yield* fs
      .rename(tempPath, filePath)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'rename', cause })),
        ),
      )
  })

/**
 * Remove a holder's lock file.
 */
const removeHolderLock = (
  filePath: string,
): Effect.Effect<void, SemaphoreBackingError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* fs
      .remove(filePath)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'remove', cause })),
        ),
      )
  })

/** Error thrown when attempting to revoke permits from a non-existent holder */
export class HolderNotFoundError extends Data.TaggedError('HolderNotFoundError')<{
  readonly key: string
  readonly holderId: string
}> {
  override get message(): string {
    return `Holder "${this.holderId}" not found for key "${this.key}"`
  }
}

/**
 * Count active (non-expired) permits in a key's directory.
 */
const countActivePermits = (
  keyDir: string,
  now: number,
): Effect.Effect<number, SemaphoreBackingError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs
      .exists(keyDir)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'exists', cause })),
        ),
      )

    if (!exists) {
      return 0
    }

    const entries = yield* fs
      .readDirectory(keyDir)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'readDirectory', cause })),
        ),
      )

    let totalPermits = 0

    for (const entry of entries) {
      if (!entry.endsWith('.lock')) continue

      const filePath = `${keyDir}/${entry}`
      const lock = yield* readHolderLock(filePath, now)

      if (lock !== undefined) {
        totalPermits += lock.permits
      }
    }

    return totalPermits
  })

/**
 * Create a file-system based distributed semaphore backing layer.
 *
 * This implementation stores lock state using one file per holder in a directory
 * structure. Each holder's lock file is written atomically using write-to-temp-
 * then-rename pattern, providing better consistency than read-modify-write on
 * a single shared file.
 *
 * Directory structure:
 * ```
 * {lockDir}/
 *   {key}/
 *     {holderId-1}.lock   # Contains { permits: N, expiresAt: timestamp }
 *     {holderId-2}.lock
 * ```
 *
 * The implementation uses:
 * - Atomic file creation via write-to-temp-then-rename
 * - One file per holder for better isolation
 * - TTL-based expiration with automatic cleanup
 * - File system watching for push-based notifications
 *
 * **Note:** While this provides much better atomicity for individual holder
 * operations, the permit counting across holders is still eventually consistent.
 * For strict distributed locking guarantees, use a proper distributed backend
 * like Redis.
 */
export const layer = (
  options: FileSystemBackingOptions,
): Layer.Layer<DistributedSemaphoreBacking, never, FileSystem.FileSystem | Path.Path> => {
  const { lockDir } = options

  const tryAcquire = (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number,
  ): Effect.Effect<boolean, SemaphoreBackingError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const keyDir = getKeyDir(lockDir, key)
      const holderPath = getHolderPath(lockDir, key, holderId)
      const now = Date.now()
      const ttlMs = Duration.toMillis(ttl)

      // First check our own existing lock
      const existingLock = yield* readHolderLock(holderPath, now)
      const existingPermits = existingLock?.permits ?? 0

      // Count total active permits (excluding our own)
      const totalActive = yield* countActivePermits(keyDir, now)
      const othersPermits = totalActive - existingPermits

      // Check if we can acquire the requested permits
      if (othersPermits + permits > limit) {
        return false
      }

      // Write our lock file
      yield* writeHolderLock(holderPath, {
        permits,
        expiresAt: now + ttlMs,
      })

      return true
    })

  const release = (
    key: string,
    holderId: string,
    permits: number,
  ): Effect.Effect<number, SemaphoreBackingError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const holderPath = getHolderPath(lockDir, key, holderId)
      const now = Date.now()

      const existingLock = yield* readHolderLock(holderPath, now)

      if (existingLock === undefined) {
        return 0
      }

      const toRelease = Math.min(permits, existingLock.permits)
      const remaining = existingLock.permits - toRelease

      if (remaining <= 0) {
        // Remove the file entirely
        yield* removeHolderLock(holderPath)
      } else {
        // Update with reduced permits
        yield* writeHolderLock(holderPath, {
          permits: remaining,
          expiresAt: existingLock.expiresAt,
        })
      }

      return toRelease
    })

  const refresh = (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    _limit: number,
    permits: number,
  ): Effect.Effect<boolean, SemaphoreBackingError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const holderPath = getHolderPath(lockDir, key, holderId)
      const now = Date.now()
      const ttlMs = Duration.toMillis(ttl)

      const existingLock = yield* readHolderLock(holderPath, now)

      if (existingLock === undefined) {
        return false
      }

      // Refresh with new expiry
      yield* writeHolderLock(holderPath, {
        permits: Math.min(permits, existingLock.permits),
        expiresAt: now + ttlMs,
      })

      return true
    })

  const getCount = (
    key: string,
    ttl: Duration.Duration,
  ): Effect.Effect<number, SemaphoreBackingError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const keyDir = getKeyDir(lockDir, key)
      const now = Date.now()

      // ttl is passed but we use the actual expiry from each lock file
      void ttl

      return yield* countActivePermits(keyDir, now)
    })

  const onPermitsReleased = (key: string): Stream.Stream<void, never, FileSystem.FileSystem> => {
    const keyDir = getKeyDir(lockDir, key)

    return Stream.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        return fs.watch(keyDir).pipe(
          Stream.filter((event) => event._tag === 'Update' || event._tag === 'Remove'),
          Stream.map((): void => undefined),
          Stream.catchAll(() => Stream.never),
        )
      }),
    )
  }

  return Layer.succeed(DistributedSemaphoreBacking, {
    tryAcquire,
    release,
    refresh,
    getCount,
    onPermitsReleased,
  } as DistributedSemaphoreBacking)
}

/**
 * Forcibly revoke all permits held by a specific holder.
 *
 * This immediately removes the holder's lock file, causing their next refresh
 * to fail with `LockLostError`. Use this for:
 * - Recovering from dead/unresponsive processes
 * - Administrative intervention
 * - Testing and debugging
 *
 * @returns The number of permits that were revoked
 */
export const forceRevoke = (
  options: FileSystemBackingOptions,
  key: string,
  targetHolderId: string,
): Effect.Effect<number, SemaphoreBackingError | HolderNotFoundError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { lockDir } = options
    const holderPath = getHolderPath(lockDir, key, targetHolderId)
    const now = Date.now()

    const existingLock = yield* readHolderLock(holderPath, now)

    if (existingLock === undefined) {
      return yield* new HolderNotFoundError({ key, holderId: targetHolderId })
    }

    yield* removeHolderLock(holderPath)

    return existingLock.permits
  }).pipe(Effect.withSpan('FileSystemBacking.forceRevoke', { attributes: { key, targetHolderId } }))

/**
 * List all active (non-expired) holders for a semaphore key.
 *
 * Useful for inspecting lock state before force-revoking, or for
 * administrative visibility into who holds permits.
 */
export const listHolders = (
  options: FileSystemBackingOptions,
  key: string,
): Effect.Effect<ReadonlyArray<HolderInfo>, SemaphoreBackingError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { lockDir } = options
    const keyDir = getKeyDir(lockDir, key)
    const now = Date.now()
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs
      .exists(keyDir)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'exists', cause })),
        ),
      )

    if (!exists) {
      return []
    }

    const entries = yield* fs
      .readDirectory(keyDir)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'readDirectory', cause })),
        ),
      )

    const holders: HolderInfo[] = []

    for (const entry of entries) {
      if (!entry.endsWith('.lock')) continue

      const filePath = `${keyDir}/${entry}`
      const lock = yield* readHolderLock(filePath, now)

      if (lock !== undefined) {
        const holderId = yield* Effect.try({
          try: () => decodeURIComponent(entry.slice(0, -5)), // Remove .lock suffix
          catch: (cause) => new SemaphoreBackingError({ operation: 'decodeURIComponent', cause }),
        })
        holders.push({
          holderId,
          permits: lock.permits,
          expiresAt: lock.expiresAt,
        })
      }
    }

    return holders
  }).pipe(Effect.withSpan('FileSystemBacking.listHolders', { attributes: { key } }))

/**
 * Forcibly revoke permits from all holders for a semaphore key.
 *
 * This is a nuclear option that clears all locks for a key.
 * Use with caution.
 *
 * @returns Array of revoked holders with their permit counts
 */
export const forceRevokeAll = (
  options: FileSystemBackingOptions,
  key: string,
): Effect.Effect<
  ReadonlyArray<{ holderId: string; permits: number }>,
  SemaphoreBackingError | HolderNotFoundError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const holders = yield* listHolders(options, key)
    const revoked: Array<{ holderId: string; permits: number }> = []

    for (const holder of holders) {
      const permits = yield* forceRevoke(options, key, holder.holderId)
      if (permits > 0) {
        revoked.push({ holderId: holder.holderId, permits })
      }
    }

    return revoked
  }).pipe(Effect.withSpan('FileSystemBacking.forceRevokeAll', { attributes: { key } }))
