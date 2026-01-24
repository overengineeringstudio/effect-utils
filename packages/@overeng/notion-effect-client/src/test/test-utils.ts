import { HttpClient, type HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Chunk, Effect, Layer, Redacted, Stream } from 'effect'

import { type NotionClientConfig, NotionConfig } from '../config.ts'

/** Mock response configuration */
export interface MockResponse {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
}

/** Create a mock HttpClient that returns predefined responses */
export const createMockHttpClient = (
  handler: (request: HttpClientRequest.HttpClientRequest) => MockResponse,
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const mockResponse = handler(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(mockResponse.body), {
          status: mockResponse.status,
          headers: {
            'content-type': 'application/json',
            ...mockResponse.headers,
          },
        }),
      )
    }),
  )

/** Create a Layer with mock HttpClient */
export const mockHttpClientLayer = (
  handler: (request: HttpClientRequest.HttpClientRequest) => MockResponse,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, createMockHttpClient(handler))

/** Create a Layer with NotionConfig for testing */
export const testConfigLayer = (
  config: NotionClientConfig = {
    authToken: Redacted.make('test-token'),
    retryEnabled: false,
  },
): Layer.Layer<NotionConfig> => Layer.succeed(NotionConfig, config)

/** Create a combined test Layer with mock HttpClient and NotionConfig */
export const createTestLayer = (
  handler: (request: HttpClientRequest.HttpClientRequest) => MockResponse,
  config: NotionClientConfig = {
    authToken: Redacted.make('test-token'),
    retryEnabled: false,
  },
): Layer.Layer<HttpClient.HttpClient | NotionConfig> =>
  Layer.mergeAll(mockHttpClientLayer(handler), testConfigLayer(config))

/** Collect all items from a Stream into an array */
export const collectStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Effect.Effect<readonly A[], E, R> =>
  Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

/** Sample Notion API responses for testing */
export const sampleResponses = {
  database: {
    object: 'database' as const,
    id: 'db-123',
    title: [{ type: 'text', text: { content: 'Test Database' } }],
  },
  page: {
    object: 'page' as const,
    id: 'page-123',
    properties: {},
  },
  block: {
    object: 'block' as const,
    id: 'block-123',
    type: 'paragraph',
  },
  user: {
    object: 'user' as const,
    id: 'user-123',
    name: 'Test User',
  },
  paginatedPages: (hasMore: boolean, nextCursor: string | null) => ({
    object: 'list' as const,
    results: [
      { object: 'page' as const, id: 'page-1' },
      { object: 'page' as const, id: 'page-2' },
    ],
    has_more: hasMore,
    next_cursor: nextCursor,
  }),
  error: (status: number, code: string, message: string) => ({
    object: 'error' as const,
    status,
    code,
    message,
  }),
}
