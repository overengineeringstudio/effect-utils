import { describe, expect, it } from 'vitest'

import { fetchWithProgress } from './download.ts'

const streamed = ({ chunks, init }: { chunks: ReadonlyArray<Uint8Array>; init?: ResponseInit }) =>
  (async () =>
    new Response(
      new ReadableStream({
        start: (controller) => {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
      init,
    )) as unknown as typeof fetch

describe('fetchWithProgress', () => {
  it('reports every chunk against the known size and returns the whole file', async () => {
    const seen: Array<[number, number]> = []
    const bytes = await fetchWithProgress({
      url: '/iroh.wasm',
      totalBytes: 5,
      onProgress: ({ receivedBytes, totalBytes }) => seen.push([receivedBytes, totalBytes]),
      fetchImpl: streamed({ chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)] }),
    })
    expect([...bytes]).toEqual([1, 2, 3, 4, 5])
    expect(seen).toEqual([
      [0, 5],
      [2, 5],
      [5, 5],
    ])
  })

  it('raises the total when the file is larger than announced', async () => {
    const seen: Array<[number, number]> = []
    await fetchWithProgress({
      url: '/iroh.wasm',
      totalBytes: 2,
      onProgress: ({ receivedBytes, totalBytes }) => seen.push([receivedBytes, totalBytes]),
      fetchImpl: streamed({ chunks: [Uint8Array.of(1, 2, 3)] }),
    })
    expect(seen.at(-1)).toEqual([3, 3])
  })

  it('fails on an HTTP error instead of handing an error page to the wasm loader', async () => {
    await expect(
      fetchWithProgress({
        url: '/iroh.wasm',
        totalBytes: 5,
        onProgress: () => {},
        fetchImpl: streamed({ chunks: [], init: { status: 404 } }),
      }),
    ).rejects.toThrow('HTTP 404')
  })
})
