import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Path } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { nmdObjectRelativePath, type NmdSyncStateV1 } from '@overeng/notion-effect-client'

import { readAllSyncStates } from './cli-program.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import type { NmdStateStore } from './state-store.ts'
import {
  garbageCollectObjects,
  isSafeRelativePath,
  NmdStateStoreLive,
  objectPath,
  writeBaseSnapshot,
  writeSyncState,
} from './state-store.ts'

const withPath = async <A>(fn: (path: Path.Path) => A): Promise<A> =>
  Effect.runPromise(Path.Path.pipe(Effect.map(fn), Effect.provide(NodeContext.layer)))

describe('notion-md state store path safety', () => {
  it('accepts content-addressed object paths under the local metadata root', async () => {
    await expect(
      withPath((path) =>
        isSafeRelativePath({
          path,
          relativePath: nmdObjectRelativePath(`sha256:${'a'.repeat(64)}`),
        }),
      ),
    ).resolves.toBe(true)
  })

  it('rejects traversal and absolute object paths', async () => {
    await expect(
      withPath((path) => [
        isSafeRelativePath({ path, relativePath: '..' }),
        isSafeRelativePath({ path, relativePath: '../outside.json' }),
        isSafeRelativePath({ path, relativePath: '.notion-md/../../outside.json' }),
        isSafeRelativePath({ path, relativePath: '/tmp/outside.json' }),
      ]),
    ).resolves.toEqual([false, false, false, false])
  })
})

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer))

const runStore = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext | NmdStateStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(stateStoreLayer, NodeContext.layer))))

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-state-store-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const syncStateFor = (opts: {
  readonly pageId: string
  readonly body: string
  readonly base: NmdSyncStateV1['body']['base']
}): NmdSyncStateV1 => ({
  version: 1,
  page_id: opts.pageId,
  body: {
    format: 'notion-enhanced-markdown',
    hash: sha256Digest(normalizeMarkdownLineEndings(opts.body)),
    base: opts.base,
    last_pulled_at: '2026-05-22T12:00:00.000Z',
    remote_last_edited_time: '2026-05-22T12:00:00.000Z',
    truncated: false,
    unknown_block_ids: [],
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
  read_only_properties: {},
  data_source: null,
})

describe('notion-md state store object lifecycle', () => {
  it('dry-runs object garbage collection without deleting unreachable objects', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000001'
      const base = await runStore(writeBaseSnapshot({ path, pageId, body: '# Base' }))
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      const result = await runStore(
        garbageCollectObjects({
          path,
          syncStates: [syncStateFor({ pageId, body: '# Base', base })],
          dryRun: true,
        }),
      )

      expect(result.dryRun).toBe(true)
      expect(result.removed).toEqual([orphanPath])
      await expect(readFile(orphanPath, 'utf8')).resolves.toBe(orphanContent)
    })
  })

  it('removes unreachable objects while keeping referenced base objects', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000001'
      const base = await runStore(writeBaseSnapshot({ path, pageId, body: '# Base' }))
      const basePath = objectPath({ path, hash: base.hash })
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      const result = await runStore(
        garbageCollectObjects({
          path,
          syncStates: [syncStateFor({ pageId, body: '# Base', base })],
        }),
      )

      expect(result.removed).toEqual([orphanPath])
      await expect(readFile(basePath, 'utf8')).resolves.toContain('# Base')
      await expect(readFile(orphanPath, 'utf8')).rejects.toThrow()
    })
  })
})

const runFs = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)))

describe('notion-md gc command discovery', () => {
  it('readAllSyncStates returns empty array when no sync directory exists', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const syncStates = await runFs(readAllSyncStates(nmdPath))
      expect(syncStates).toEqual([])
    })
  })

  it('readAllSyncStates discovers sync states written by writeSyncState', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000002'
      const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Hello' }))
      const syncState = syncStateFor({ pageId, body: '# Hello', base })
      await runStore(writeSyncState({ path: nmdPath, syncState }))

      const found = await runFs(readAllSyncStates(nmdPath))
      expect(found).toHaveLength(1)
      expect(found[0]?.page_id).toBe(pageId)
    })
  })

  it('gc plan-only (no --prune): identifies unreachable objects without deleting them', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000003'
      const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Plan' }))
      const syncState = syncStateFor({ pageId, body: '# Plan', base })
      await runStore(writeSyncState({ path: nmdPath, syncState }))

      // Add an orphan object
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      // Dry-run (plan only): discover sync states from disk, do not delete
      const syncStates = await runFs(readAllSyncStates(nmdPath))
      const result = await runStore(
        garbageCollectObjects({ path: nmdPath, syncStates, dryRun: true }),
      )

      expect(result.dryRun).toBe(true)
      expect(result.removed).toContain(orphanPath)
      // Object must still exist on disk
      await expect(readFile(orphanPath, 'utf8')).resolves.toBe(orphanContent)
    })
  })

  it('gc --prune: removes unreachable objects, keeps all objects reachable from sync states', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const pageIdA = '00000000-0000-4000-8000-000000000004'
      const pageIdB = '00000000-0000-4000-8000-000000000005'

      // Write two base snapshots (two pages in the same directory / state root)
      const baseA = await runStore(
        writeBaseSnapshot({ path: nmdPath, pageId: pageIdA, body: '# A' }),
      )
      const baseB = await runStore(
        writeBaseSnapshot({ path: nmdPath, pageId: pageIdB, body: '# B' }),
      )
      const syncStateA = syncStateFor({ pageId: pageIdA, body: '# A', base: baseA })
      const syncStateB = syncStateFor({ pageId: pageIdB, body: '# B', base: baseB })
      await runStore(writeSyncState({ path: nmdPath, syncState: syncStateA }))
      await runStore(writeSyncState({ path: nmdPath, syncState: syncStateB }))

      // Add an orphan object
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      // Discover sync states from disk (as the gc command does), then prune
      const syncStates = await runFs(readAllSyncStates(nmdPath))
      expect(syncStates).toHaveLength(2)
      const result = await runStore(
        garbageCollectObjects({ path: nmdPath, syncStates, dryRun: false }),
      )

      // Orphan removed, both base snapshots kept
      expect(result.removed).toContain(orphanPath)
      expect(result.reachable).toContain(objectPath({ path: nmdPath, hash: baseA.hash }))
      expect(result.reachable).toContain(objectPath({ path: nmdPath, hash: baseB.hash }))
      await expect(readFile(orphanPath, 'utf8')).rejects.toThrow()
      await expect(
        readFile(objectPath({ path: nmdPath, hash: baseA.hash }), 'utf8'),
      ).resolves.toContain('# A')
      await expect(
        readFile(objectPath({ path: nmdPath, hash: baseB.hash }), 'utf8'),
      ).resolves.toContain('# B')
    })
  })
})
