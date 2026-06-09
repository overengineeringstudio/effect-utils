import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { formatReasonMessage } from './string.ts'

Vitest.describe('formatReasonMessage', () => {
  /* The cause segment is space-separated like the other parts, so it reads
   * `... (method) : message` — preserving the pre-existing `RestateError` /
   * `PtyError` `get message()` output exactly (SSOT consolidation, no behavior
   * change). */
  Vitest.it('joins reason + (method) + Error cause message', () => {
    expect(
      formatReasonMessage({
        reason: 'IngressFailed',
        method: 'call',
        cause: new Error('connection refused'),
      }),
    ).toBe('IngressFailed (call) : connection refused')
  })

  Vitest.it('includes an optional [label] between reason and (method)', () => {
    expect(formatReasonMessage({ reason: 'WriteFailed', label: 'sess-1', method: 'press' })).toBe(
      'WriteFailed [sess-1] (press)',
    )
  })

  Vitest.it('stringifies a non-Error cause', () => {
    expect(formatReasonMessage({ reason: 'RunFailed', method: 'step', cause: 'boom' })).toBe(
      'RunFailed (step) : boom',
    )
  })

  Vitest.it('omits absent parts (reason only)', () => {
    expect(formatReasonMessage({ reason: 'Closed' })).toBe('Closed')
  })

  Vitest.it('omits the cause segment when cause is undefined', () => {
    expect(formatReasonMessage({ reason: 'Timeout', method: 'waitFor' })).toBe('Timeout (waitFor)')
  })
})
