/**
 * OtelConfig service
 *
 * Configuration for the OTEL observability stack derived from environment variables.
 * Provides URLs for the Collector, Tempo, and Grafana services.
 */

import { Context, Effect, Layer } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** Configuration data for the OTEL observability stack. */
export interface OtelConfigData {
  /** OTEL Collector OTLP HTTP endpoint (basePort+0). */
  readonly collectorUrl: string
  /** Tempo HTTP query API endpoint (basePort+2). */
  readonly tempoQueryUrl: string
  /** Grafana HTTP UI endpoint (basePort+3). */
  readonly grafanaUrl: string
  /** OTEL Collector internal metrics endpoint (basePort+4). */
  readonly metricsUrl: string
}

// =============================================================================
// Service
// =============================================================================

/** OTEL stack configuration derived from environment variables. */
export class OtelConfig extends Context.Tag('OtelConfig')<OtelConfig, OtelConfigData>() {
  /**
   * Live layer that reads configuration from environment variables.
   *
   * Expected env vars (set by devenv otel module):
   * - `OTEL_EXPORTER_OTLP_ENDPOINT` — Collector OTLP HTTP URL (basePort+0)
   * - `OTEL_GRAFANA_URL` — Grafana HTTP URL (basePort+3)
   *
   * Tempo and metrics URLs are derived from the collector port.
   */
  static live = Layer.effect(
    OtelConfig,
    Effect.gen(function* () {
      const collectorUrl = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
      const grafanaUrl = process.env['OTEL_GRAFANA_URL']

      if (collectorUrl === undefined || collectorUrl.length === 0) {
        return yield* Effect.die(
          new Error('OTEL_EXPORTER_OTLP_ENDPOINT is not set. Is the OTEL devenv module enabled?'),
        )
      }

      if (grafanaUrl === undefined || grafanaUrl.length === 0) {
        return yield* Effect.die(
          new Error('OTEL_GRAFANA_URL is not set. Is the OTEL devenv module enabled?'),
        )
      }

      // Derive other URLs from the collector base port.
      // Port scheme: +0=Collector, +1=Tempo gRPC, +2=Tempo HTTP, +3=Grafana, +4=Metrics, +5=Tempo internal gRPC
      const collectorPort = new URL(collectorUrl).port
      const basePort = parseInt(collectorPort, 10)

      const tempoQueryUrl = `http://127.0.0.1:${String(basePort + 2)}`
      const metricsUrl = `http://127.0.0.1:${String(basePort + 4)}`

      return {
        collectorUrl,
        tempoQueryUrl,
        grafanaUrl,
        metricsUrl,
      }
    }),
  )

  /** Create a config layer from explicit values (useful for testing). */
  static fromConfig = (config: OtelConfigData) => Layer.succeed(OtelConfig, config)
}
