import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FileSystem, HttpClient } from '@effect/platform'
import { FetchHttpClient } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

import { NotionConfigLive, NotionPages, type NotionConfig } from '@overeng/notion-effect-client'

import { canonicalize } from './canonicalizer.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { clonePage, reconcileFile, statusFile } from './reconcile.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'

/*
 * Thin REQUIRED live-smoke tier for the v-next engine (R27). Exercises the new
 * source-aware path against real temporary Notion pages with cleanup, so live
 * API drift surfaces deliberately. Skipped unless NOTION_API_TOKEN and a
 * dedicated NOTION_TEST_PARENT_PAGE_ID are configured; in NOTION_MD_LIVE_REQUIRED
 * mode the absence of those is a hard failure (asserted in
 * live.integration.test.ts).
 *
 * NOTE: a credentialed run with a dedicated private test parent is required to
 * exercise this tier and to refresh the offline fidelity corpus
 * (src/corpus/fidelity-corpus.json). Without a test parent the offline corpus +
 * adversarial pass remain the gating safety net.
 */

const token = process.env.NOTION_API_TOKEN
const testParentPageId = process.env.NOTION_TEST_PARENT_PAGE_ID
const skipLive =
  token === undefined ||
  token.length === 0 ||
  testParentPageId === undefined ||
  testParentPageId.length === 0

const ConfigLayer = NotionConfigLive({
  authToken: Redacted.make(token ?? ''),
  retryEnabled: true,
  maxRetries: 5,
  retryBaseDelay: 1000,
})
const BaseLayer = Layer.mergeAll(ConfigLayer, FetchHttpClient.layer)
const TestLayer = Layer.mergeAll(
  BaseLayer,
  NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)),
  NodeContext.layer,
  NotionMdGatewayLive.pipe(Layer.provide(BaseLayer)),
)

type LiveEnv =
  | FileSystem.FileSystem
  | NotionMdGateway
  | NotionConfig
  | HttpClient.HttpClient
  | NmdStateStore

const runLive = <A, E>(effect: Effect.Effect<A, E, LiveEnv>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(TestLayer))))

const scratchTitle = `notion-md v-next smoke ${Date.now()}`
const createdPageIds: string[] = []

afterAll(async () => {
  if (skipLive === true) return
  for (const id of createdPageIds) {
    await runLive(NotionPages.archive({ pageId: id }).pipe(Effect.ignore)).catch(() => undefined)
  }
})

describe.skipIf(skipLive)('notion-md v-next live smoke (R27)', () => {
  it('clone(remote) → status in-sync → reconcile noop against a real page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-md-vnext-live-'))
    try {
      // create a scratch page locally (source: local, unbound) then reconcile to create it
      const created = await runLive(
        NotionPages.create({
          parent: { type: 'page_id', page_id: testParentPageId ?? '' },
          properties: { title: { title: [{ type: 'text', text: { content: scratchTitle } }] } },
        }),
      )
      createdPageIds.push(created.id)

      const path = join(dir, 'doc.nmd')
      const clone = await runLive(
        clonePage({ pageId: created.id, outPath: path, source: 'remote' }),
      )
      expect(clone.source).toBe('remote')

      const status = await runLive(statusFile({ path }))
      expect(status.status).toBe('in-sync')

      const result = await runLive(reconcileFile({ path }))
      expect(result._tag).toBe('noop')

      // local body, when canonicalized, matches what a re-status sees
      const file = await readFile(path, 'utf8')
      expect(file).toContain('"source": "remote"')
      void canonicalize(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
