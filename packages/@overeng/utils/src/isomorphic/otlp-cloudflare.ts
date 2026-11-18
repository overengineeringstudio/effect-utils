import { Effect, Redacted } from 'effect'

import { type ProducerConfig, producerEndpoint } from './otlp-producer.ts'

export interface ObservabilityDestinationProps {
  readonly name: string
  readonly url: string
  readonly headers: Record<string, Redacted.Redacted<string>>
  readonly logpushDataset: 'opentelemetry-traces' | 'opentelemetry-logs'
  readonly skipPreflightCheck: true
}

/** Cloudflare owns gzip OTLP-JSON serialization; preflight is not native delivery proof. */
export const cloudflareDestinationProps = (
  name: string,
  config: ProducerConfig & {
    readonly transport: Extract<ProducerConfig['transport'], { kind: 'https' }>
  },
): {
  readonly traces: ObservabilityDestinationProps
  readonly logs: ObservabilityDestinationProps
} => {
  const endpoint = producerEndpoint(config.transport)
  const headers = {
    authorization: Redacted.make(`Bearer ${Redacted.value(config.bearer)}`),
    'CF-Access-Client-Id': config.transport.access.clientId,
    'CF-Access-Client-Secret': config.transport.access.clientSecret,
  }
  return {
    traces: {
      name: `${name}-traces`,
      url: `${endpoint}/v1/traces`,
      headers,
      logpushDataset: 'opentelemetry-traces',
      skipPreflightCheck: true,
    },
    logs: {
      name: `${name}-logs`,
      url: `${endpoint}/v1/logs`,
      headers,
      logpushDataset: 'opentelemetry-logs',
      skipPreflightCheck: true,
    },
  }
}

/**
 * Pass the maintained Alchemy Cloudflare.Workers.ObservabilityDestination constructor.
 * Constructor injection preserves the consumer's pinned provider/resource context without
 * installing a second Alchemy version in the producer library.
 * Destination headers live in sensitive Alchemy state; never return them as stack outputs.
 */
export const declareCloudflareProducer = <TSlug, TError, TContext>(
  destination: (
    id: string,
    props: ObservabilityDestinationProps,
  ) => Effect.Effect<{ readonly slug: TSlug }, TError, TContext>,
  name: string,
  config: Parameters<typeof cloudflareDestinationProps>[1],
) =>
  Effect.gen(function* () {
    const props = cloudflareDestinationProps(name, config)
    const traces = yield* destination(`${name}-traces`, props.traces)
    const logs = yield* destination(`${name}-logs`, props.logs)
    return {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        persist: false,
        headSamplingRate: 1,
        invocationLogs: true,
        destinations: [logs.slug],
      },
      traces: { enabled: true, persist: false, headSamplingRate: 1, destinations: [traces.slug] },
    }
  })
