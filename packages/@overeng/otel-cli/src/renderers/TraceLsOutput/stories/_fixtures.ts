/**
 * Test fixtures for TraceLs stories
 *
 * Provides realistic trace listing state factories for Storybook.
 */

import type { LsState } from '../schema.ts'

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): LsState => ({
  _tag: 'Loading',
  message: 'Searching traces...',
})

/** Error state. */
export const errorState = (): LsState => ({
  _tag: 'Error',
  error: 'Unreachable',
  message: 'Failed to connect to Grafana. Is the OTEL stack running?',
})

/** Empty results. */
export const emptyState = (): LsState => ({
  _tag: 'Success',
  traces: [],
  limit: 10,
})

/** Typical trace listing. */
export const defaultState = (): LsState => ({
  _tag: 'Success',
  traces: [
    {
      traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
      serviceName: 'dt',
      spanName: 'check:quick',
      durationMs: 22000,
    },
    {
      traceId: 'abc123def456789012345678abcdef01',
      serviceName: 'dt',
      spanName: 'check:quick',
      durationMs: 18500,
    },
    {
      traceId: 'deadbeef12345678deadbeef12345678',
      serviceName: 'dt',
      spanName: 'ts:check',
      durationMs: 14200,
    },
    {
      traceId: '0123456789abcdef0123456789abcdef',
      serviceName: 'dt',
      spanName: 'check:all',
      durationMs: 45600,
    },
    {
      traceId: 'cafebabe00112233cafebabe00112233',
      serviceName: 'dt',
      spanName: 'check:quick',
      durationMs: 19800,
    },
  ],
  limit: 10,
})

/** Filtered results with a query. */
export const filteredState = (): LsState => ({
  _tag: 'Success',
  traces: [
    {
      traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
      serviceName: 'dt',
      spanName: 'check:quick',
      durationMs: 22000,
    },
  ],
  query: '{resource.service.name="dt"}',
  limit: 10,
})
