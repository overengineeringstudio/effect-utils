import type { HttpClientRequest } from '@effect/platform'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionDatabases } from './databases.ts'
import { createTestLayer, sampleResponses } from './test/test-utils.ts'

/** Decode a JSON request body regardless of the underlying HttpBody encoding. */
const decodeJsonBody = (req: HttpClientRequest.HttpClientRequest): Record<string, unknown> => {
  const raw = (req.body as { readonly body?: unknown }).body
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw))
  if (typeof raw === 'string') return JSON.parse(raw)
  throw new Error(`unexpected request body shape: ${JSON.stringify(req.body)}`)
}

Vitest.describe('NotionDatabases.create', () => {
  Vitest.it.effect(
    'nests properties under initial_data_source (API 2026-03-11 data_source split)',
    () =>
      Effect.gen(function* () {
        let captured: HttpClientRequest.HttpClientRequest | undefined

        // Effect.either: the response-decode result is irrelevant here — we assert the
        // outbound request body, which the handler captures before any decode.
        yield* NotionDatabases.create({
          parent: { type: 'page_id', page_id: 'page-1' },
          title: [{ type: 'text', text: { content: 'Items' } }],
          properties: { Name: { title: {} }, Stage: { status: {} } },
        }).pipe(
          Effect.either,
          Effect.provide(
            createTestLayer((req) => {
              captured = req
              return { status: 200, body: sampleResponses.database }
            }),
          ),
        )

        const body = decodeJsonBody(captured!)

        // The schema must NOT be at the top level (silently dropped by the API),
        // and MUST live under initial_data_source.properties.
        expect(body.properties).toBeUndefined()
        expect(body.initial_data_source).toEqual({
          properties: { Name: { title: {} }, Stage: { status: {} } },
        })
        expect(body.parent).toEqual({ type: 'page_id', page_id: 'page-1' })
      }),
  )

  Vitest.it.effect('passes initialDataSourceTitle through to initial_data_source', () =>
    Effect.gen(function* () {
      let captured: HttpClientRequest.HttpClientRequest | undefined

      const dsTitle = [{ type: 'text', text: { content: 'Items DS' } }]
      yield* NotionDatabases.create({
        parent: { type: 'page_id', page_id: 'page-1' },
        title: [{ type: 'text', text: { content: 'Items' } }],
        properties: { Name: { title: {} } },
        initialDataSourceTitle: dsTitle,
      }).pipe(
        Effect.either,
        Effect.provide(
          createTestLayer((req) => {
            captured = req
            return { status: 200, body: sampleResponses.database }
          }),
        ),
      )

      const body = decodeJsonBody(captured!) as {
        readonly initial_data_source: Record<string, unknown>
      }
      expect(body.initial_data_source.title).toEqual(dsTitle)
    }),
  )
})
