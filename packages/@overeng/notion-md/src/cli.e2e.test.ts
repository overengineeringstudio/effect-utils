import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { type NmdSyncStateV1 } from '@overeng/notion-effect-client'

import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import {
  NmdStateStoreLive,
  objectPath,
  writeBaseSnapshot,
  writeSyncState,
  type NmdStateStore,
} from './state-store.ts'

/*
 * CLI boundary tests for the decided v-next surface: three verbs `track` /
 * `status` / `sync` over self-describing files. These were revised from the
 * pre-redesign surface (`plan`, `--from-remote`, `--root`, `--root-file`,
 * two-arg `sync`) which the v-next redesign explicitly DROPS — direction lives
 * in each file's frontmatter `source`, not in flags (R34). The old assertions
 * encoded the superseded engine and would contradict the decided spec.
 */

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const cliProcessTimeoutMs = 20_000
const cliTestTimeoutMs = 25_000

const runCli = (args: readonly string[]) =>
  execFileAsync('bun', ['src/cli.ts', ...args], {
    cwd: packageDir,
    timeout: cliProcessTimeoutMs,
    env: {
      ...process.env,
      NOTION_API_TOKEN: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
  })

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer))

const runStore = <A, E>(
  effect: Effect.Effect<A, E, NmdStateStore | NodeContext.NodeContext>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(stateStoreLayer, NodeContext.layer))))

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

describe('notion-md CLI boundary', () => {
  const withTempDir = async <T>(callback: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'notion-md-cli-'))
    try {
      return await callback(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it(
    'renders top-level help with the three decided verbs',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).toContain('track')
      expect(stdout).toContain('status')
      expect(stdout).toContain('sync')
    },
    cliTestTimeoutMs,
  )

  it(
    'no longer exposes the dropped tree/direction flags or the plan verb',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).not.toContain('--from-remote')
      expect(stdout).not.toContain('--root')
      expect(stdout).not.toContain('--root-file')
      expect(stdout).not.toContain('clone')
      expect(stdout).not.toContain('plan')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders sync help without requiring a Notion token',
    async () => {
      const { stdout } = await runCli(['sync', '--help'])

      expect(stdout).toContain('--watch')
      expect(stdout).toContain('--poll-interval-ms')
      expect(stdout).toContain('--recursive')
      expect(stdout).toContain('--concurrency')
      expect(stdout).toContain('--force')
      expect(stdout).toContain('--dry-run')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders track help with --as direction option',
    async () => {
      const { stdout } = await runCli(['track', '--help'])

      expect(stdout).toContain('--as')
      expect(stdout).toContain('--dry-run')
      expect(stdout).toContain('page-id-or-url')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates missing sync targets before resolving Notion credentials',
    async () => {
      await expect(runCli(['sync'])).rejects.toThrow('Missing argument <path>')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates watch polling interval before resolving Notion credentials',
    async () => {
      await expect(
        runCli(['sync', 'page.nmd', '--watch', '--poll-interval-ms', '0']),
      ).rejects.toThrow('Expected a positive number')
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects a non-page-id track argument before resolving Notion credentials',
    async () => {
      await withTempDir(async (dir) => {
        const filePath = join(dir, 'page.nmd')
        writeFileSync(filePath, '')

        await expect(runCli(['track', filePath])).rejects.toMatchObject({
          stdout: expect.stringContaining('Invalid Notion page id/url'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'surfaces missing Notion credentials as a typed CLI failure after argument validation',
    async () => {
      await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
        stdout: expect.stringContaining('NmdTokenMissingError'),
      })
      await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
        stdout: expect.stringContaining('NOTION_API_TOKEN is required'),
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'renders gc help with --prune option (no Notion token required)',
    async () => {
      const { stdout } = await runCli(['gc', '--help'])

      expect(stdout).toContain('--prune')
      expect(stdout).toContain('--recursive')
      expect(stdout).toContain('path')
    },
    cliTestTimeoutMs,
  )

  it(
    'gc is registered in top-level help',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).toContain('gc')
    },
    cliTestTimeoutMs,
  )

  it(
    'gc validates missing targets without requiring a Notion token',
    async () => {
      await expect(runCli(['gc'])).rejects.toThrow('Missing argument <path>')
    },
    cliTestTimeoutMs,
  )

  it(
    'gc (no --prune) reports the removal plan and deletes nothing',
    async () => {
      await withTempDir(async (dir) => {
        const nmdPath = join(dir, 'doc.nmd')
        writeFileSync(nmdPath, '')
        const pageId = '00000000-0000-4000-8000-000000000010'

        // Set up fixtures: base snapshot + sync state + orphan object
        const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Hello' }))
        const syncState = syncStateFor({ pageId, body: '# Hello', base })
        await runStore(writeSyncState({ path: nmdPath, syncState }))

        // Add an orphan object that has no sync-state reference
        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        // gc without --prune: plan-only
        const { stdout } = await runCli(['gc', nmdPath])

        // Orphan reported in plan output
        expect(stdout).toContain(orphanPath)
        // Plan-only marker in output
        expect(stdout).toContain('plan only')

        // Orphan must still exist on disk — nothing deleted
        expect(existsSync(orphanPath)).toBe(true)
        // Base snapshot must still exist too
        expect(existsSync(objectPath({ path: nmdPath, hash: base.hash }))).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'gc --prune removes unreachable objects and keeps reachable base snapshots',
    async () => {
      await withTempDir(async (dir) => {
        const nmdPath = join(dir, 'doc.nmd')
        writeFileSync(nmdPath, '')
        const pageId = '00000000-0000-4000-8000-000000000011'

        // Set up fixtures: base snapshot + sync state + orphan object
        const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# World' }))
        const syncState = syncStateFor({ pageId, body: '# World', base })
        await runStore(writeSyncState({ path: nmdPath, syncState }))

        // Add an orphan object
        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        // gc with --prune: actually deletes orphans
        const { stdout } = await runCli(['gc', nmdPath, '--prune'])

        // Output confirms pruning occurred (not plan-only)
        expect(stdout).toContain('objects pruned')

        // Orphan must be gone
        expect(existsSync(orphanPath)).toBe(false)
        // Base snapshot must still exist
        expect(existsSync(objectPath({ path: nmdPath, hash: base.hash }))).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )
})
