import { Effect } from 'effect'

import { Vitest } from '../../mod.ts'

const PRODUCT_SPAN_NAME = 'vitest-otel-e2e.product'

Vitest.scopedLive('bridges an Effect product span', (test) =>
  Effect.void.pipe(
    // oxlint-disable-next-line overeng/no-raw-otel-primitives -- direct probe of the generic Vitest-to-Effect bridge
    Effect.withSpan(PRODUCT_SPAN_NAME),
    Vitest.withTestCtx(test, { forceOtel: true }),
  ),
)
