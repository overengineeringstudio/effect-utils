import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  OtelAttributeKey,
  OtelMetricName,
  OtelSpanName,
  otelScrapeAttributeKeys,
  otelScrapeMetricNames,
  otelScrapeProfileFields,
  otelScrapeSchemas,
  otelScrapeSpanNames,
  otelScrapeTelemetryRegistry,
} from '../mod.ts'

describe('otel-scrape generated telemetry registry', () => {
  it('exports the semantic names required by the VRS', async () => {
    expect(otelScrapeSpanNames.command).toBe('otel_scrape.command')
    expect(otelScrapeSpanNames.process).toBe('otel_scrape.process')
    expect(otelScrapeAttributeKeys.adapterName).toBe('otel_scrape.adapter.name')
    expect(otelScrapeAttributeKeys.processCommandArgsHash).toBe('process.command_args_hash')
    expect(otelScrapeAttributeKeys.processExitCode).toBe('process.exit_code')
    expect(otelScrapeProfileFields.byteLength).toBe('byteLength')
    expect(otelScrapeSchemas.summaryV1).toBe('otel-scrape.summary/v1')

    for (const spanName of Object.values(otelScrapeSpanNames)) {
      await expect(Effect.runPromise(Schema.decodeUnknown(OtelSpanName)(spanName))).resolves.toBe(
        spanName,
      )
    }

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
    expect(otelScrapeTelemetryRegistry.spans.map((span) => span.name)).toEqual(
      Object.values(otelScrapeSpanNames),
    )
    expect(otelScrapeTelemetryRegistry.attributes.map((attribute) => attribute.key)).toEqual(
      Object.values(otelScrapeAttributeKeys),
    )
  })
})
