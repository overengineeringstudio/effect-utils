import type { Attributes, Span, Tracer } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'

import { SyncEvent } from '../renderer/sync-events.ts'
import { createOtelEventHandler } from './otel-adapter.ts'

interface RecordedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
  readonly events: { name: string; attrs: Record<string, unknown>; time: number | undefined }[]
  status: { code: number; message?: string } | undefined
  endTime: number | undefined
  ended: boolean
}

const makeFakeTracer = (): { tracer: Tracer; spans: RecordedSpan[] } => {
  const spans: RecordedSpan[] = []
  const tracer: Tracer = {
    startSpan: (name: string, opts?: { attributes?: Attributes; startTime?: number }) => {
      const rec: RecordedSpan = {
        name,
        attributes: { ...opts?.attributes },
        events: [],
        status: undefined,
        endTime: undefined,
        ended: false,
      }
      spans.push(rec)
      const span: Partial<Span> = {
        setAttributes(attrs) {
          Object.assign(rec.attributes, attrs)
          return span as Span
        },
        setAttribute(key: string, value: unknown) {
          rec.attributes[key] = value
          return span as Span
        },
        setStatus(status) {
          rec.status = {
            code: status.code,
            ...(status.message !== undefined ? { message: status.message } : {}),
          }
          return span as Span
        },
        addEvent(eventName: string, attrs?: Attributes, time?: number) {
          rec.events.push({ name: eventName, attrs: { ...attrs }, time })
          return span as Span
        },
        end(endTime?: number) {
          rec.endTime = endTime
          rec.ended = true
        },
      }
      return span as Span
    },
    startActiveSpan: (() => {
      throw new Error('not used')
    }) as unknown as Tracer['startActiveSpan'],
  }
  return { tracer, spans }
}

const ROOT = '11111111-2222-4333-8444-555555555555'

describe('createOtelEventHandler', () => {
  it('emits a root sync span + op child spans with expected attributes', () => {
    const { tracer, spans } = makeFakeTracer()
    const handler = createOtelEventHandler({ tracer, serviceName: 'pixeltrail-sync' })

    handler(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 3, at: 1_000 }))
    handler(SyncEvent.CacheOutcome({ kind: 'miss', pageId: ROOT, at: 1_001 }))
    handler(SyncEvent.OpIssued({ id: 1, kind: 'append', at: 1_010 }))
    handler(
      SyncEvent.OpSucceeded({ id: 1, kind: 'append', durationMs: 5, resultCount: 2, at: 1_020 }),
    )
    handler(SyncEvent.BatchFlush({ issued: 2, batched: 2, at: 1_020 }))
    handler(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 25, ok: true, opCount: 1, at: 1_030 }))

    expect(spans).toHaveLength(2)
    const [root, op] = spans
    expect(root!.name).toBe('notion-react.sync')
    expect(root!.attributes['service.name']).toBe('pixeltrail-sync')
    expect(root!.attributes['span.label']).toBe('11111111')
    expect(root!.attributes['notion-react.page_id']).toBe(ROOT)
    expect(root!.attributes['notion-react.ok']).toBe(true)
    expect(root!.attributes['notion-react.op_count']).toBe(1)
    expect(root!.ended).toBe(true)
    expect(root!.endTime).toBe(1_030)
    expect(root!.events.map((e) => e.name)).toEqual(['cache:miss', 'batch-flush'])

    expect(op!.name).toBe('notion-react.op.append')
    expect(op!.attributes['span.label']).toBe('append')
    expect(op!.attributes['notion-react.op.result_count']).toBe(2)
    expect(op!.ended).toBe(true)
  })

  it('failed op marks span ERROR status and records error attribute', () => {
    const { tracer, spans } = makeFakeTracer()
    const handler = createOtelEventHandler({ tracer })
    handler(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 0, at: 0 }))
    handler(SyncEvent.OpIssued({ id: 7, kind: 'update', at: 10 }))
    handler(SyncEvent.OpFailed({ id: 7, kind: 'update', durationMs: 3, error: 'boom', at: 20 }))
    handler(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 30, ok: false, opCount: 0, at: 30 }))

    const op = spans.find((s) => s.name === 'notion-react.op.update')!
    expect(op.status?.code).toBe(2) // ERROR
    expect(op.attributes['notion-react.op.error']).toBe('boom')
    const root = spans.find((s) => s.name === 'notion-react.sync')!
    expect(root.status?.code).toBe(2)
    expect(root.attributes['notion-react.ok']).toBe(false)
  })

  it('is re-entrant safe across two independent handlers', () => {
    const a = makeFakeTracer()
    const b = makeFakeTracer()
    const handlerA = createOtelEventHandler({ tracer: a.tracer })
    const handlerB = createOtelEventHandler({ tracer: b.tracer })

    handlerA(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 1, at: 0 }))
    handlerB(SyncEvent.SyncStart({ pageId: ROOT, rootBlockCount: 1, at: 0 }))
    handlerA(SyncEvent.OpIssued({ id: 1, kind: 'append', at: 1 }))
    handlerB(SyncEvent.OpIssued({ id: 1, kind: 'append', at: 1 }))
    handlerA(SyncEvent.OpSucceeded({ id: 1, kind: 'append', durationMs: 1, resultCount: 1, at: 2 }))
    handlerB(SyncEvent.OpFailed({ id: 1, kind: 'append', durationMs: 1, error: 'x', at: 2 }))
    handlerA(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 3, ok: true, opCount: 1, at: 3 }))
    handlerB(SyncEvent.SyncEnd({ pageId: ROOT, durationMs: 3, ok: false, opCount: 0, at: 3 }))

    expect(a.spans.every((s) => s.ended)).toBe(true)
    expect(b.spans.every((s) => s.ended)).toBe(true)
    expect(a.spans.find((s) => s.name === 'notion-react.op.append')!.status?.code).toBe(1)
    expect(b.spans.find((s) => s.name === 'notion-react.op.append')!.status?.code).toBe(2)
  })
})
