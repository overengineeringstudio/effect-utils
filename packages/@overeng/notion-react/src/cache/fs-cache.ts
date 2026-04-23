import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { Effect, Schema } from 'effect'

import { CacheError } from '../renderer/errors.ts'
import { CACHE_SCHEMA_VERSION, CacheTree, type NotionCache } from './types.ts'

const decode = Schema.decodeUnknown(CacheTree)

const readIfExists = (filePath: string): Effect.Effect<string | undefined, CacheError> =>
  Effect.tryPromise({
    try: async (): Promise<string | undefined> => {
      try {
        return await fs.readFile(filePath, 'utf8')
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
          return undefined
        }
        throw err
      }
    },
    catch: (cause) => new CacheError({ reason: 'fs-cache-read-failed', cause }),
  })

/**
 * Cache backed by a single JSON file on disk. Writes go to a temp sibling
 * and atomically rename into place so a crash mid-write doesn't corrupt
 * the cache.
 *
 * A schema-version mismatch or malformed payload transparently returns
 * `undefined` from `load` (i.e. behaves like a cold cache).
 */
export const FsCache = {
  make: (filePath: string): NotionCache => ({
    load: Effect.gen(function* () {
      const contents = yield* readIfExists(filePath)
      if (contents === undefined) return undefined
      const raw = yield* Effect.try({
        try: () => JSON.parse(contents) as unknown,
        catch: (cause) => new CacheError({ reason: 'fs-cache-parse-failed', cause }),
      })
      const decoded = yield* decode(raw).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (decoded === undefined) return undefined
      if (decoded.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined
      return decoded
    }),
    save: (tree) =>
      Effect.tryPromise({
        try: async () => {
          const body = JSON.stringify(tree)
          const dir = path.dirname(filePath)
          await fs.mkdir(dir, { recursive: true })
          // Per-call unique temp name so concurrent saves in one process
          // don't race on a shared pathname (which would surface as ENOENT
          // when one rename pulls the temp out from under another writer).
          const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
          await fs.writeFile(tmp, body, 'utf8')
          await fs.rename(tmp, filePath)
        },
        catch: (cause) => new CacheError({ reason: 'fs-cache-write-failed', cause }),
      }),
  }),
} as const
