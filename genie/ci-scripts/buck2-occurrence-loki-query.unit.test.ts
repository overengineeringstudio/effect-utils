import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { Effect, type Result } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import { fetchOccurrenceLoki, OccurrenceLokiQueryError } from './buck2-occurrence-loki-query.ts'
import type { RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'

const hourMs = 3_600_000
const hourNs = BigInt(hourMs) * 1_000_000n
const route = '/buck2-occurrences/v1/query_range'
type Row = readonly [string, string]
type ObservedRequest = Pick<Request, 'url' | 'method'>
const response = (streams: ReadonlyArray<ReadonlyArray<Row>>) =>
  JSON.stringify({
    status: 'success',
    data: { resultType: 'streams', result: streams.map((values) => ({ values })) },
  })
const snapshot = (lines: string[]) => {
  const body = `${lines.join('\n')}\n`
  const hash = createHash('sha256').update(body).digest('hex')
  return {
    file: { name: `loki-${hash}.jsonl`, body },
    rows: lines.map((line, ordinal) =>
      JSON.stringify({
        type: 'buck2.occurrence.ledger',
        version: 1,
        snapshotSha256: hash,
        ordinal,
        recordCount: lines.length,
        line,
      }),
    ),
  }
}
const sample = snapshot(['{"type":"conversion"}', '{"type":"occurrence"}'])

// This suite intentionally exercises the real FetchHttpClient against an ephemeral loopback
// server. No mocked client or injected transport can hide redirect or streaming behavior.
const withReader = async (
  handler: (request: Request, index: number) => Response,
  run: (url: string, requests: ObservedRequest[]) => Promise<void>,
) => {
  const requests: ObservedRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      // Bun can release Request metadata after the response; retain only observed values.
      requests.push({ url: request.url, method: request.method })
      return handler(request, requests.length - 1)
    },
  })
  try {
    await run(`http://127.0.0.1:${server.port}${route}`, requests)
  } finally {
    await server.stop(true)
  }
}
const query = (
  url: string,
  options: {
    windowStartMs?: number
    windowEndMs?: number
    host?: string
  } = {},
) =>
  Effect.runPromise(
    fetchOccurrenceLoki({
      url,
      windowStartMs: 0,
      windowEndMs: hourMs,
      ...options,
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.result),
  )
const expectFailure = (
  result: Result.Result<RetainedOccurrenceFile[], OccurrenceLokiQueryError>,
  reason: string,
) => {
  expect(result._tag).toBe('Failure')
  if (result._tag === 'Failure') {
    expect(result.failure).toBeInstanceOf(OccurrenceLokiQueryError)
    expect(result.failure.message).toContain(reason)
    expect(result.failure.message).toContain('coverage UNKNOWN')
  }
}

test('exhausts every hourly half-open window and reconstructs snapshots spanning hours', async () => {
  await withReader(
    (_request, index) =>
      new Response(
        response(index < 2 ? [[[(BigInt(index) * hourNs).toString(), sample.rows[index]!]]] : [[]]),
      ),
    async (url, requests) => {
      const result = await query(url, { windowEndMs: 2 * hourMs + 123, host: 'runner-1' })
      expect(result).toMatchObject({ _tag: 'Success', success: [sample.file] })
      expect(requests.map((request) => new URL(request.url).search)).toEqual([
        `?start=0&end=${hourNs - 1n}&limit=5000&direction=forward&host=runner-1`,
        `?start=${hourNs}&end=${2n * hourNs - 1n}&limit=5000&direction=forward&host=runner-1`,
        `?start=${2n * hourNs}&end=${2n * hourNs + 123_000_000n - 1n}&limit=5000&direction=forward&host=runner-1`,
      ])
      expect(requests.every((request) => request.method === 'GET')).toBe(true)
    },
  )
})

test('continues full pages inclusively, retaining unseen tied rows and split snapshots', async () => {
  const large = snapshot(Array.from({ length: 5000 }, (_, index) => JSON.stringify({ index })))
  const first: Row[] = Array.from({ length: 4999 }, (_, index) => [
    String(index + 1),
    large.rows[index]!,
  ])
  first.push(['5000', sample.rows[0]!])
  await withReader(
    (_request, index) =>
      new Response(
        response(
          index === 0
            ? [first]
            : [
                [['5000', sample.rows[0]!]],
                [
                  ['5000', large.rows[4999]!],
                  ['5000', sample.rows[1]!],
                ],
              ],
        ),
      ),
    async (url, requests) => {
      expect(await query(url)).toMatchObject({
        _tag: 'Success',
        success: [large.file, sample.file],
      })
      expect(requests).toHaveLength(2)
      expect(new URL(requests[1]!.url).searchParams.get('start')).toBe('5000')
    },
  )
})

test('fails a full cursor tie page rather than silently losing unknown rows', async () => {
  await withReader(
    () =>
      new Response(response([Array.from({ length: 5000 }, () => ['1', sample.rows[0]!] as const)])),
    async (url, requests) => {
      expectFailure(await query(url), 'cursor cannot advance')
      expect(requests).toHaveLength(2)
    },
  )
})

test('rejects malformed, out-of-window, over-limit and unordered pages without retrying', async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['{', 'Malformed'],
    ['{"status":"error"}', 'Malformed'],
    [response([[['not-ns', sample.rows[0]!]]]), 'timestamp'],
    [response([[['-1', sample.rows[0]!]]]), 'timestamp'],
    [response([[[hourNs.toString(), sample.rows[0]!]]]), 'outside'],
    [
      response([
        [
          ['2', sample.rows[0]!],
          ['1', sample.rows[1]!],
        ],
      ]),
      'nonmonotonic',
    ],
    [response([Array.from({ length: 5001 }, () => ['1', sample.rows[0]!] as const)]), 'page limit'],
    [response([[['1', 'not-envelope']]]), 'snapshots'],
    [response([[['1', sample.rows[0]!]]]), 'snapshots'],
  ]
  for (const [body, reason] of cases) {
    await withReader(
      () => new Response(body),
      async (url, requests) => {
        expectFailure(await query(url), reason)
        expect(requests).toHaveLength(1)
      },
    )
  }
  // A continuation must also reject rows before its new inclusive cursor.
  await withReader(
    (_request, index) =>
      new Response(
        response([
          index === 0
            ? Array.from({ length: 5000 }, () => ['2', sample.rows[0]!] as const)
            : [['1', sample.rows[1]!]],
        ]),
      ),
    async (url) => {
      expectFailure(await query(url), 'outside')
    },
  )
})

test('rejects invalid UTF-8 rather than replacing corrupt producer bytes', async () => {
  await withReader(
    () => new Response(new Uint8Array([0xff])),
    async (url) => {
      expectFailure(await query(url), 'Malformed')
    },
  )
})

test('surfaces real HTTP connection failure as typed unknown coverage', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(response([])),
  })
  const url = `http://127.0.0.1:${server.port}${route}`
  await server.stop(true)
  expectFailure(await query(url), 'HTTP transport failed')
})

test('does not require global ordering between individually forward streams', async () => {
  await withReader(
    () => new Response(response([[['10', sample.rows[0]!]], [['1', sample.rows[1]!]]])),
    async (url) => {
      expect(await query(url)).toMatchObject({ _tag: 'Success', success: [sample.file] })
    },
  )
})

test('refuses redirects and HTTP failures without following or retrying', async () => {
  for (const status of [302, 500]) {
    await withReader(
      (request) =>
        new Response('', {
          status,
          headers: { Location: new URL('/redirected', request.url).href },
        }),
      async (url, requests) => {
        expectFailure(await query(url), `HTTP ${status}`)
        expect(requests).toHaveLength(1)
      },
    )
  }
})

test('validates the fixed URL, host and window before issuing a request', async () => {
  await withReader(
    () => new Response(response([])),
    async (url, requests) => {
      for (const invalid of [
        `${url}?query=anything`,
        `${url}#fragment`,
        url.replace(route, '/other'),
        `${url}?`,
      ])
        expectFailure(await query(invalid), 'URL')
      expectFailure(await query(url, { host: 'host/selector' }), 'host')
      expectFailure(await query(url, { windowStartMs: 1, windowEndMs: 1 }), 'window')
      expectFailure(await query(url, { windowStartMs: 0.5 }), 'window')
      expectFailure(await query(url, { windowEndMs: 25 * hourMs }), 'at most 24 hours')
      expect(requests).toHaveLength(0)
    },
  )
})

const paddedResponse = (mebibytes: number) => {
  const padding = new Uint8Array(1024 * 1024).fill(32)
  let remaining = mebibytes
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(padding)
        else {
          controller.enqueue(new TextEncoder().encode(response([])))
          controller.close()
        }
      },
    }),
  )
}

test('enforces the real streamed 64 MiB per-page byte cap', async () => {
  await withReader(
    () => paddedResponse(65),
    async (url, requests) => {
      expectFailure(await query(url), 'Response byte cap exceeded')
      expect(requests).toHaveLength(1)
    },
  )
}, 30_000)

test('shares the 512 MiB download budget across hourly responses', async () => {
  await withReader(
    () => paddedResponse(60),
    async (url, requests) => {
      expectFailure(await query(url, { windowEndMs: 9 * hourMs }), 'Total downloaded byte cap hit')
      expect(requests).toHaveLength(9)
    },
  )
}, 60_000)
