/**
 * Test fixtures for Health stories
 *
 * Provides OTEL stack health state factories and timeline for Storybook.
 */

import type { ComponentHealth, HealthAction, HealthState } from '../schema.ts'

// =============================================================================
// Component Data
// =============================================================================

/** Healthy Grafana component. */
const grafanaHealthy: ComponentHealth = {
  name: 'Grafana',
  healthy: true,
  version: '11.4.0',
  message: 'database: ok',
}

/** Healthy Tempo component. */
const tempoHealthy: ComponentHealth = {
  name: 'Tempo',
  healthy: true,
  message: 'ready',
}

/** Healthy Collector component. */
const collectorHealthy: ComponentHealth = {
  name: 'Collector',
  healthy: true,
  message: 'metrics endpoint responding',
}

/** Unhealthy Grafana component. */
const grafanaUnhealthy: ComponentHealth = {
  name: 'Grafana',
  healthy: false,
  message: 'connection refused',
}

/** Unhealthy Tempo component. */
const tempoUnhealthy: ComponentHealth = {
  name: 'Tempo',
  healthy: false,
  message: 'connection refused',
}

/** Unhealthy Collector component. */
const collectorUnhealthy: ComponentHealth = {
  name: 'Collector',
  healthy: false,
  message: 'connection refused',
}

// =============================================================================
// State Config
// =============================================================================

/** Configuration for creating a final success state. */
export interface HealthStateConfig {
  components: ComponentHealth[]
  allHealthy: boolean
}

/** All-healthy config. */
export const allHealthyConfig: HealthStateConfig = {
  components: [grafanaHealthy, tempoHealthy, collectorHealthy],
  allHealthy: true,
}

/** Partially unhealthy config. */
export const partiallyUnhealthyConfig: HealthStateConfig = {
  components: [grafanaHealthy, tempoUnhealthy, collectorHealthy],
  allHealthy: false,
}

/** All unhealthy config. */
export const allUnhealthyConfig: HealthStateConfig = {
  components: [grafanaUnhealthy, tempoUnhealthy, collectorUnhealthy],
  allHealthy: false,
}

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): HealthState => ({
  _tag: 'Loading',
  message: 'Checking OTEL stack health...',
})

/** Create a final success state from config. */
export const createFinalState = (config: HealthStateConfig): HealthState => ({
  _tag: 'Success',
  allHealthy: config.allHealthy,
  components: config.components,
})

/** Error state. */
export const errorState = (): HealthState => ({
  _tag: 'Error',
  error: 'ConfigError',
  message: 'OTEL_EXPORTER_OTLP_ENDPOINT is not set. Is the OTEL devenv module enabled?',
})

// =============================================================================
// Timeline Factory
// =============================================================================

/** Step duration between timeline events in milliseconds. */
const STEP_DURATION = 600

/**
 * Create a timeline that animates through Loading, checking each component,
 * then arriving at the final state.
 *
 * Each step adds one more component to the results, simulating progressive
 * health checks arriving.
 */
export const createTimeline = (
  config: HealthStateConfig,
): Array<{ at: number; action: HealthAction }> => {
  const timeline: Array<{ at: number; action: HealthAction }> = []

  for (let i = 0; i < config.components.length; i++) {
    const isLast = i === config.components.length - 1
    timeline.push({
      at: (i + 1) * STEP_DURATION,
      action: {
        _tag: 'SetHealth',
        components: config.components.slice(0, i + 1),
        allHealthy: isLast ? config.allHealthy : true,
      },
    })
  }

  return timeline
}

/**
 * Create a timeline that ends in an error state.
 *
 * Simulates the CLI attempting to check health and then failing with a config error.
 */
export const createErrorTimeline = (): Array<{ at: number; action: HealthAction }> => [
  {
    at: STEP_DURATION,
    action: {
      _tag: 'SetError',
      error: 'ConfigError',
      message: 'OTEL_EXPORTER_OTLP_ENDPOINT is not set. Is the OTEL devenv module enabled?',
    },
  },
]
