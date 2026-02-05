/**
 * Test fixtures for Health stories
 *
 * Provides OTEL stack health state factories for Storybook.
 */

import type { HealthState } from '../schema.ts'

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): HealthState => ({
  _tag: 'Loading',
  message: 'Checking OTEL stack health...',
})

/** All healthy. */
export const allHealthyState = (): HealthState => ({
  _tag: 'Success',
  allHealthy: true,
  components: [
    { name: 'Grafana', healthy: true, version: '11.4.0', message: 'database: ok' },
    { name: 'Tempo', healthy: true, message: 'ready' },
    { name: 'Collector', healthy: true, message: 'metrics endpoint responding' },
  ],
})

/** Partially unhealthy. */
export const partiallyUnhealthyState = (): HealthState => ({
  _tag: 'Success',
  allHealthy: false,
  components: [
    { name: 'Grafana', healthy: true, version: '11.4.0', message: 'database: ok' },
    { name: 'Tempo', healthy: false, message: 'connection refused' },
    { name: 'Collector', healthy: true, message: 'metrics endpoint responding' },
  ],
})

/** All unhealthy. */
export const allUnhealthyState = (): HealthState => ({
  _tag: 'Success',
  allHealthy: false,
  components: [
    { name: 'Grafana', healthy: false, message: 'connection refused' },
    { name: 'Tempo', healthy: false, message: 'connection refused' },
    { name: 'Collector', healthy: false, message: 'connection refused' },
  ],
})

/** Error state. */
export const errorState = (): HealthState => ({
  _tag: 'Error',
  error: 'ConfigError',
  message: 'OTEL_EXPORTER_OTLP_ENDPOINT is not set. Is the OTEL devenv module enabled?',
})
