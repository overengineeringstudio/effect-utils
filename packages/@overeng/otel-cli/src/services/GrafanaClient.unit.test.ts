import { describe, expect, it } from 'vitest'

import type { GrafanaQueryResponse } from './GrafanaClient.ts'
import { parseDataFrames } from './GrafanaClient.ts'

// =============================================================================
// Helpers
// =============================================================================

/** Create a Grafana query response with standard trace search columns. */
const makeQueryResponse = (
  rows: Array<{
    traceId: string
    serviceName: string
    spanName: string
    durationMs: number
  }>,
): GrafanaQueryResponse => ({
  results: {
    A: {
      frames: [
        {
          schema: {
            fields: [
              { name: 'traceID' },
              { name: 'traceService' },
              { name: 'traceName' },
              { name: 'traceDuration' },
            ],
          },
          data: {
            values: [
              rows.map((r) => r.traceId),
              rows.map((r) => r.serviceName),
              rows.map((r) => r.spanName),
              rows.map((r) => r.durationMs),
            ],
          },
        },
      ],
    },
  },
})

// =============================================================================
// Tests
// =============================================================================

describe('parseDataFrames', () => {
  it('returns empty array when no frames', () => {
    const response: GrafanaQueryResponse = {
      results: { A: {} },
    }

    expect(parseDataFrames(response)).toEqual([])
  })

  it('returns empty array when frames is empty', () => {
    const response: GrafanaQueryResponse = {
      results: { A: { frames: [] } },
    }

    expect(parseDataFrames(response)).toEqual([])
  })

  it('parses a single row correctly', () => {
    const response = makeQueryResponse([
      { traceId: 'abc123', serviceName: 'my-svc', spanName: 'GET /api', durationMs: 42 },
    ])

    const results = parseDataFrames(response)

    expect(results).toEqual([
      { traceId: 'abc123', serviceName: 'my-svc', spanName: 'GET /api', durationMs: 42 },
    ])
  })

  it('parses multiple rows', () => {
    const response = makeQueryResponse([
      { traceId: 'aaa', serviceName: 'svc-a', spanName: 'op-1', durationMs: 10 },
      { traceId: 'bbb', serviceName: 'svc-b', spanName: 'op-2', durationMs: 20 },
      { traceId: 'ccc', serviceName: 'svc-c', spanName: 'op-3', durationMs: 30 },
    ])

    const results = parseDataFrames(response)

    expect(results).toHaveLength(3)
    expect(results[0]!.traceId).toBe('aaa')
    expect(results[2]!.durationMs).toBe(30)
  })

  it('skips frames missing required columns', () => {
    const response: GrafanaQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [{ name: 'traceID' }, { name: 'someOtherField' }],
              },
              data: {
                values: [['abc'], [123]],
              },
            },
          ],
        },
      },
    }

    expect(parseDataFrames(response)).toEqual([])
  })

  it('handles columns in non-standard order', () => {
    const response: GrafanaQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'traceDuration' },
                  { name: 'traceName' },
                  { name: 'traceID' },
                  { name: 'traceService' },
                ],
              },
              data: {
                values: [[100], ['op'], ['trace-1'], ['svc']],
              },
            },
          ],
        },
      },
    }

    const results = parseDataFrames(response)

    expect(results).toEqual([
      { traceId: 'trace-1', serviceName: 'svc', spanName: 'op', durationMs: 100 },
    ])
  })

  it('combines results from multiple frames', () => {
    const response: GrafanaQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'traceID' },
                  { name: 'traceService' },
                  { name: 'traceName' },
                  { name: 'traceDuration' },
                ],
              },
              data: {
                values: [['aaa'], ['svc-1'], ['op-1'], [10]],
              },
            },
            {
              schema: {
                fields: [
                  { name: 'traceID' },
                  { name: 'traceService' },
                  { name: 'traceName' },
                  { name: 'traceDuration' },
                ],
              },
              data: {
                values: [['bbb'], ['svc-2'], ['op-2'], [20]],
              },
            },
          ],
        },
      },
    }

    const results = parseDataFrames(response)

    expect(results).toHaveLength(2)
    expect(results[0]!.traceId).toBe('aaa')
    expect(results[1]!.traceId).toBe('bbb')
  })

  it('coerces non-string values via String()', () => {
    const response: GrafanaQueryResponse = {
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'traceID' },
                  { name: 'traceService' },
                  { name: 'traceName' },
                  { name: 'traceDuration' },
                ],
              },
              data: {
                values: [[12345], [null], [undefined], ['50']],
              },
            },
          ],
        },
      },
    }

    const results = parseDataFrames(response)

    expect(results).toHaveLength(1)
    expect(results[0]!.traceId).toBe('12345')
    expect(results[0]!.durationMs).toBe(50)
  })
})
