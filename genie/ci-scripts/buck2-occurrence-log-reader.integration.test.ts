import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import { Effect } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import { readOccurrenceLogs, type OccurrenceLogReadOptions } from './buck2-occurrence-log-reader.ts'
import { filesFor, reconcile } from './buck2-occurrence-records.fixtures.ts'

type Row = [string, string]
const fixture = (lines: string[]) => {
  const body = `${lines.join('\n')}\n`
  const hash = createHash('sha256').update(body).digest('hex')
  return lines.map((line, ordinal): Row => [String(ordinal * 2), JSON.stringify({
    type: 'buck2.occurrence.ledger', version: 1, snapshotSha256: hash,
    ordinal, recordCount: lines.length, line,
  })])
}
const response = (rows: Row[], warnings?: string[]) => Response.json({
  status: 'success', warnings,
  data: { resultType: 'streams', result: [{ stream: { host_name: 'test-host' }, values: rows }] },
})
const withServer = async <A>(options: {
  handler: (request: Request) => Response
  body: (url: string) => Promise<A>
}): Promise<A> => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: options.handler })
  try {
    return await options.body(new URL('/buck2-occurrences/v1/query_range', server.url).href)
  } finally {
    await server.stop(true)
  }
}
const read = (options: Partial<OccurrenceLogReadOptions> & { url: string }) =>
  Effect.runPromise(readOccurrenceLogs({
    startNs: 0n, endNs: 8n, hosts: ['test-host'], reserveRequest: () => true, ...options,
  }).pipe(Effect.provide(FetchHttpClient.layer)))

describe('governed occurrence log HTTP reader', () => {
  it('feeds conversion, manifest and independent census records through strict reconciliation', async () => {
    const input = filesFor()
    const rows = input.flatMap((file) => fixture(file.body.slice(0, -1).split('\n')))
    await withServer({
      handler: () => response(rows),
      body: async (url) => {
        const result = await read({ url })
        expect(result.files).toHaveLength(input.length)
        expect(reconcile({ files: result.files }).records).toEqual(reconcile({ files: input }).records)
      },
    })
  })

  it('excludes conflicting replayed snapshots received over HTTP', async () => {
    const rows = fixture(['header', 'row'])
    await withServer({
      handler: () => response([...rows, ['0', rows[0]![1].replace('"line":"header"', '"line":"other"')]]),
      body: async (url) => {
        const result = await read({ url })
        expect(result.files).toEqual([])
        expect(result.evidenceGaps).toContain('occurrence-log-conflicting-line')
      },
    })
  })

  it('bisects saturated windows preserving exact half-open bounds', async () => {
    const rows = fixture(['header', 'row1', 'row2', 'row3'])
    const requests: string[][] = []
    await withServer({
      handler: (request) => {
        const url = new URL(request.url)
        expect(url.pathname).toBe('/buck2-occurrences/v1/query_range')
        expect([...url.searchParams.keys()].sort()).toEqual(['direction', 'end', 'host', 'limit', 'start'])
        expect(url.searchParams.get('direction')).toBe('forward')
        expect(url.searchParams.get('host')).toBe('test-host')
        const start = url.searchParams.get('start')!
        const end = url.searchParams.get('end')!
        requests.push([start, end])
        return response(rows.filter(([at]) => BigInt(at) >= BigInt(start) && BigInt(at) < BigInt(end)).slice(0, 2))
      },
      body: async (url) => {
        const result = await read({ url, pageLimit: 2 })
        expect(result.files.map((file) => file.body)).toEqual(['header\nrow1\nrow2\nrow3\n'])
        expect(result.evidenceGaps).toEqual(['occurrence-log-ingestion-closure-unproven'])
      },
    })
    expect(requests).toContainEqual(['0', '8'])
    expect(requests).toContainEqual(['0', '2'])
    expect(requests).toContainEqual(['6', '8'])
  })

  it('reports a saturated 1ns bucket instead of skipping equal-timestamp rows', async () => {
    const rows = fixture(['header', 'row']).map(([, body]): Row => ['3', body])
    const requests: string[][] = []
    await withServer({
      handler: (request) => {
        const params = new URL(request.url).searchParams
        const start = params.get('start')!
        const end = params.get('end')!
        requests.push([start, end])
        return response(3n >= BigInt(start) && 3n < BigInt(end) ? rows : [])
      },
      body: async (url) => {
        const result = await read({ url, pageLimit: 2 })
        expect(result.evidenceGaps).toContain('occurrence-log-saturated-nanosecond')
        expect(result.files).toHaveLength(1)
      },
    })
    expect(requests).toContainEqual(['3', '4'])
  })

  it('deduplicates replay and makes missing lines, warnings and malformed rows explicit', async () => {
    const rows = fixture(['header', 'missing'])
    await withServer({
      handler: () => response([rows[0]!, rows[0]!, ['1', '{invalid']], ['partial results']),
      body: async (url) => {
        const result = await read({ url })
        expect(result.files).toEqual([])
        expect(result.evidenceGaps).toContain('occurrence-log-incomplete-snapshot')
        expect(result.evidenceGaps).toContain('occurrence-log-malformed-envelope')
        expect(result.evidenceGaps).toContain('occurrence-log-backend-warning')
      },
    })
  })

  it('refuses errors, redirects and oversized responses without silently reporting completeness', async () => {
    for (const status of [302, 403, 500]) {
      await withServer({
        handler: () => new Response('', { status, headers: { location: 'https://example.invalid/' } }),
        body: async (url) => expect((await read({ url })).evidenceGaps).toContain('occurrence-log-query-gap'),
      })
    }
    await withServer({
      handler: () => new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          const chunk = new Uint8Array(1024 * 1024)
          for (let index = 0; index < 65; index++) controller.enqueue(chunk)
          controller.close()
        },
      })),
      body: async (url) => expect((await read({ url })).evidenceGaps).toContain('occurrence-log-query-gap'),
    })
  })

  it('reserves the shared API budget before sending any request', async () => {
    let requests = 0
    await withServer({
      handler: () => { requests++; return response([]) },
      body: async (url) => {
        const result = await read({ url, reserveRequest: () => false })
        expect(result.evidenceGaps).toContain('occurrence-log-api-budget-exhausted')
      },
    })
    expect(requests).toBe(0)
  })
})
