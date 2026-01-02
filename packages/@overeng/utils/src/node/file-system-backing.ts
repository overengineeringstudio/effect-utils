import { FileSystem, Path } from '@effect/platform'
import { Duration, Effect, Layer, Schema, Stream } from 'effect'
import { DistributedSemaphoreBacking, SemaphoreBackingError } from 'effect-distributed-lock'

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

/**
 * Read a holder's lock file, returning undefined if it doesn't exist or is expired.
 */
const readHolderLock = (
  filePath: string,
  now: number,
): Effect.Effect<HolderLockContent | undefined, SemaphoreBackingError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs
      .exists(filePath)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'exists', cause })),
        ),
      )

    if (!exists) {
      return undefined
    }

    const content = yield* fs
      .readFileString(filePath)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.fail(new SemaphoreBackingError({ operation: 'readFile', cause })),
        ),
      )

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
