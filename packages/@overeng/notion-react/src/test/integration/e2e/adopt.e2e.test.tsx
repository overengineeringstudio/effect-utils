import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { NotionBlocks } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../../cache/in-memory-cache.ts'
import {
  BulletedListItem,
  Callout,
  ChildPage,
  Code,
  Heading2,
  Page,
  Paragraph,
  Toggle,
} from '../../../components/blocks.ts'
import { Bold, Link } from '../../../components/inline.ts'
import { adopt, AdoptionRefusedError } from '../../../renderer/adopt.ts'
import { plan, sync } from '../../../renderer/sync.ts'
import { SKIP_E2E, withScratchPage } from './helpers.ts'

/**
 * Live-API coverage for `adopt()` (#1093). The mock stores request-shape
 * payloads, so mock roundtrips cannot exercise the response-shape deltas the
 * readback content gate absorbs (decorated rich text, explicit defaults,
 * provider-injected callout icons/code language, decorated title spans) —
 * only the real API produces those. This is the load-bearing case for
 * adoption: a stateless redeploy must adopt a page the REAL API rendered.
 */

const DEFAULT_TIMEOUT = 60_000

describe.skipIf(SKIP_E2E)('adopt() against the live API (e2e)', () => {
  it(
    'stateless adoption: sync → discard cache → adopt → plan is empty, zero mutations',
    async () => {
      const element = (pageId: string) => (
        <Page title={`adopt probe ${pageId.slice(0, 8)}`} icon={{ type: 'emoji', emoji: '🧬' }}>
          <Heading2>Section</Heading2>
          <Paragraph blockKey="intro">
            Hello <Bold>world</Bold> with <Link href="https://example.com/x">a link</Link>
          </Paragraph>
          <Toggle blockKey="t1" title="Details">
            <Paragraph>nested body</Paragraph>
            <Code language="typescript">const x = 1</Code>
          </Toggle>
          <Callout>no icon claimed — server injects a default</Callout>
          <BulletedListItem>alpha</BulletedListItem>
          <ChildPage blockKey="sub" title="Sub Page" icon={{ type: 'emoji', emoji: '📄' }}>
            <Paragraph blockKey="p1">sub content</Paragraph>
          </ChildPage>
        </Page>
      )
      await withScratchPage('adopt-stateless', (pageId) =>
        Effect.gen(function* () {
          // Render live state, then simulate a stateless redeploy by
          // discarding the cache entirely.
          yield* sync(element(pageId), { pageId, cache: InMemoryCache.make() })

          const adopted = yield* adopt(element(pageId), { pageId })

          // The adopted cache reaches the zero-op fixpoint immediately.
          const p = yield* plan(element(pageId), {
            pageId,
            cache: InMemoryCache.make(adopted),
          })
          expect(p.empty).toBe(true)
          expect(p.fallbackReason).toBeUndefined()
        }),
      )
    },
    DEFAULT_TIMEOUT * 3,
  )

  it(
    'drift recovery: out-of-band edit refuses strictly, adopt-live + one sync repairs, strict re-adoption succeeds',
    async () => {
      const element = (
        <>
          <Paragraph blockKey="a">alpha body</Paragraph>
          <Paragraph blockKey="b">beta body</Paragraph>
        </>
      )
      await withScratchPage('adopt-drift-recovery', (pageId) =>
        Effect.gen(function* () {
          yield* sync(element, { pageId, cache: InMemoryCache.make() })

          // Out-of-band tamper: edit the first paragraph directly.
          const live = yield* NotionBlocks.retrieveChildren({ blockId: pageId })
          const first = live.results[0] as { id: string }
          yield* NotionBlocks.update({
            blockId: first.id,
            paragraph: { rich_text: [{ type: 'text', text: { content: 'tampered' } }] },
          })

          // Strict adoption refuses with ContentDrift pinned to the block.
          const err = yield* adopt(element, { pageId }).pipe(Effect.flip)
          expect(err).toBeInstanceOf(AdoptionRefusedError)
          const refusals = (err as AdoptionRefusedError).refusals
          expect(refusals.map((r) => r._tag)).toEqual(['ContentDrift'])

          // adopt-live records the live marker; the next sync emits exactly
          // one repairing update; strict re-adoption then succeeds.
          const adopted = yield* adopt(element, { pageId, onContentDrift: 'adopt-live' })
          const res = yield* sync(element, { pageId, cache: InMemoryCache.make(adopted) })
          expect({
            appends: res.appends,
            inserts: res.inserts,
            updates: res.updates,
            removes: res.removes,
          }).toEqual({ appends: 0, inserts: 0, updates: 1, removes: 0 })

          const readopted = yield* adopt(element, { pageId })
          const p = yield* plan(element, { pageId, cache: InMemoryCache.make(readopted) })
          expect(p.empty).toBe(true)
        }),
      )
    },
    DEFAULT_TIMEOUT * 3,
  )
})
