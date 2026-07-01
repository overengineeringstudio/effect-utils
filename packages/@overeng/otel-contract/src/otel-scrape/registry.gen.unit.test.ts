import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  OtelAttributeKey,
  OtelMetricName,
  otelScrapeAttributeKeys,
  otelScrapeMetricNames,
  otelScrapeProfileFields,
  otelScrapeSchemas,
  otelScrapeSpanNaming,
  otelScrapeTelemetryRegistry,
} from '../mod.ts'

describe('otel-scrape generated telemetry registry', () => {
  it('exports the semantic names required by the VRS', async () => {
    // Spans are named by the operation (decision 0014): the registry owns the
    // naming *scheme* per span id, not a fixed span-name string.
    expect(otelScrapeSpanNaming.command).toBe('program-basename')
    expect(otelScrapeSpanNaming.process).toBe('descendant-basename')
    expect(otelScrapeAttributeKeys.scopeName).toBe('otel.scope.name')
    expect(otelScrapeAttributeKeys.spanOrigin).toBe('span.origin')
    expect(otelScrapeAttributeKeys.commandProgram).toBe('command.program')
    expect(otelScrapeAttributeKeys.commandArgvHash).toBe('command.argv_hash')
    expect(otelScrapeAttributeKeys.commandCwdHash).toBe('command.cwd_hash')
    expect(otelScrapeAttributeKeys.adapterName).toBe('otel_scrape.adapter.name')
    expect(otelScrapeAttributeKeys.processExitCode).toBe('process.exit_code')
    expect(otelScrapeAttributeKeys.processObservationBackend).toBe(
      'otel_scrape.process.observation.backend',
    )
    expect(otelScrapeAttributeKeys.processObservationFidelity).toBe(
      'otel_scrape.process.observation.fidelity',
    )
    expect(otelScrapeAttributeKeys.processObservationRelation).toBe(
      'otel_scrape.process.observation.relation',
    )
    expect(otelScrapeMetricNames.oxlintDiagnostics).toBe('oxlint.diagnostics')
    expect(otelScrapeProfileFields.byteLength).toBe('byteLength')
    expect(otelScrapeSchemas.summaryV1).toBe('otel-scrape.summary/v1')

    for (const attributeKey of Object.values(otelScrapeAttributeKeys)) {
      await expect(
        Effect.runPromise(Schema.decodeUnknown(OtelAttributeKey)(attributeKey)),
      ).resolves.toBe(attributeKey)
    }

    for (const metricName of Object.values(otelScrapeMetricNames)) {
      await expect(
        Effect.runPromise(Schema.decodeUnknown(OtelMetricName)(metricName)),
      ).resolves.toBe(metricName)
    }
  })

  it('keeps generated constants aligned with the registry projection', () => {
    expect(otelScrapeTelemetryRegistry.spans.map((span) => span.naming)).toEqual(
      Object.values(otelScrapeSpanNaming),
    )
    expect(otelScrapeTelemetryRegistry.attributes.map((attribute) => attribute.key)).toEqual(
      Object.values(otelScrapeAttributeKeys),
    )
  })
})
