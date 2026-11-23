import { Context, Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { Paragraph } from '../components/blocks.ts'
import { createFakeNotion } from '../test/mock-client.ts'
import { NotionRendererClient, NotionRendererClientLive } from './client.ts'
import { renderToNotionWithClient } from './render-to-notion.ts'
import { sync, syncWithClient, planWithClient } from './sync.ts'

const pageId = '00000000-0000-4000-8000-000000000001'

describe('injected renderer client', () => {
  it('runs keyed sync and a read-only plan without token or HttpClient services', async () => {
    const fake = createFakeNotion()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            NotionRendererClientLive.pipe(Layer.provide(fake.layer)),
          )
          const client = Context.get(context, NotionRendererClient)
          const cache = InMemoryCache.make()
          const page = <Paragraph blockKey="stable">Hello</Paragraph>
          const first = yield* syncWithClient(page, { pageId, cache }).pipe(
            Effect.provideService(NotionRendererClient, client),
          )
          expect(first.appends).toBe(1)
          const id = fake.childrenOf(pageId)[0]!.id
          const unchanged = yield* syncWithClient(page, { pageId, cache }).pipe(
            Effect.provideService(NotionRendererClient, client),
          )
          expect(unchanged).toMatchObject({ appends: 0, updates: 0, removes: 0 })
          const changed = <Paragraph blockKey="stable">Changed</Paragraph>
          const before = fake.requests.filter((request) => request.method !== 'GET').length
          const preview = yield* planWithClient(changed, { pageId, cache }).pipe(
            Effect.provideService(NotionRendererClient, client),
          )
          expect(preview.ops.some((op) => op.kind === 'update')).toBe(true)
          expect(fake.requests.filter((request) => request.method !== 'GET').length).toBe(before)
          yield* syncWithClient(changed, { pageId, cache }).pipe(
            Effect.provideService(NotionRendererClient, client),
          )
          expect(fake.childrenOf(pageId)[0]!.id).toBe(id)
        }),
      ),
    )
  })

  it('keeps the default bearer-token route working', async () => {
    const fake = createFakeNotion()
    const result = await Effect.runPromise(
      sync(<Paragraph>Default</Paragraph>, { pageId, cache: InMemoryCache.make() }).pipe(
        Effect.provide(fake.layer),
      ),
    )
    expect(result.appends).toBe(1)
  })

  it('supports append-only rendering through the same injected capability', async () => {
    const fake = createFakeNotion()
    const result = await Effect.runPromise(
      renderToNotionWithClient(<Paragraph>Injected</Paragraph>, { pageId }).pipe(
        Effect.provide(NotionRendererClientLive.pipe(Layer.provide(fake.layer))),
      ),
    )
    expect(result.appends).toBe(1)
  })
})
