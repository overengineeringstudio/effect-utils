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
  children: [
    {
      key: 'b:hello',
      blockId: 'blk-1',
      type: 'paragraph',
      hash: 'h1',
      children: [],
      nodeKind: 'block',
    },
  ],
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

  // C4: a v1 (pre-`type`-on-CacheNode) blob on disk must invalidate. The
  // current schema is v2; loading a v1 blob returns undefined and the next
  // sync re-seeds the cache at the current schema version with `type`
  // populated on every node.
  it('invalidates a pre-bump v1 cache blob (no `type` on nodes)', async () => {
    const file = path.join(dir, 'c.json')
    const v1Blob = {
      schemaVersion: 1,
      rootId: 'root-1',
      children: [{ key: 'b:hello', blockId: 'blk-1', hash: 'h1', children: [] }],
    }
    await fs.writeFile(file, JSON.stringify(v1Blob), 'utf8')
    const cache = FsCache.make(file)
    const out = await Effect.runPromise(cache.load)
    expect(out).toBeUndefined()
  })

  it('re-seeds at current schema version after a v1 invalidation', async () => {
    const file = path.join(dir, 'c.json')
    await fs.writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, rootId: 'root-1', children: [] }),
      'utf8',
    )
    const cache = FsCache.make(file)
    expect(await Effect.runPromise(cache.load)).toBeUndefined()
    // Save a fresh tree at the current schema and round-trip it back.
    const fresh = sampleTree()
    await Effect.runPromise(cache.save(fresh))
    const loaded = await Effect.runPromise(cache.load)
    expect(loaded).toEqual(fresh)
    expect(loaded?.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(loaded?.children[0]?.type).toBe('paragraph')
  })
})
