import { Effect } from 'effect'

import {
  flushCaptureSpans,
  makeOteliteCaptureLayer,
  OteliteCapture,
} from '../../../otelite/vitest-bridge.ts'
import { Vitest } from '../../mod.ts'

const CAPTURED_SPAN_NAME = 'vitest-otel-e2e.captured-product'

const exportInterval = 100
const CaptureLayer = makeOteliteCaptureLayer({ exportInterval })

Vitest.scopedLive('keeps the assertion product span root and singular', (test) =>
  Effect.gen(function* () {
    const capture = yield* OteliteCapture

    yield* Effect.void.pipe(
      // oxlint-disable-next-line overeng/no-raw-otel-primitives -- direct probe of capture-lane bridge suppression
      Effect.withSpan(CAPTURED_SPAN_NAME),
    )
    yield* flushCaptureSpans({ exportInterval })

    const spans = yield* capture.inspect({ signal: 'traces', name: CAPTURED_SPAN_NAME })
    Vitest.expect(spans).toHaveLength(1)
    const inheritedTraceId = process.env.TRACEPARENT?.split('-')[1]
    Vitest.expect(inheritedTraceId).toBeDefined()
    Vitest.expect(spans[0]?.trace_id).not.toBe(inheritedTraceId)
  }).pipe(Vitest.withTestCtx(test, { makeLayer: () => CaptureLayer })),
)
