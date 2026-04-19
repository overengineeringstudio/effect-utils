import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FsCache } from './fs-cache.ts'
import { CACHE_SCHEMA_VERSION, type CacheTree } from './types.ts'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-react-fs-cache-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const sampleTree = (): CacheTree => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  rootId: 'root-1',
  children: [{ key: 'b:hello', blockId: 'blk-1', hash: 'h1', children: [] }],
})

describe('FsCache', () => {
  it('returns undefined when no cache file exists', async () => {
    const cache = FsCache.make(path.join(dir, 'missing.json'))
    const out = await Effect.runPromise(cache.load)
    expect(out).toBeUndefined()
  })

  it('roundtrips save -> load', async () => {
    const cache = FsCache.make(path.join(dir, 'c.json'))
    const tree = sampleTree()
    await Effect.runPromise(cache.save(tree))
    const loaded = await Effect.runPromise(cache.load)
    expect(loaded).toEqual(tree)
  })

  it('treats a schema-version mismatch as a cold cache', async () => {
    const file = path.join(dir, 'c.json')
    await fs.writeFile(
      file,
      JSON.stringify({ schemaVersion: 999, rootId: 'root', children: [] }),
      'utf8',
    )
    const cache = FsCache.make(file)
    const out = await Effect.runPromise(cache.load)
    expect(out).toBeUndefined()
  })

  it('treats malformed JSON as a cold cache (parse failure is an error)', async () => {
    const file = path.join(dir, 'c.json')
    await fs.writeFile(file, '{ not-json', 'utf8')
    const cache = FsCache.make(file)
    await expect(Effect.runPromise(cache.load)).rejects.toThrow()
  })
})
