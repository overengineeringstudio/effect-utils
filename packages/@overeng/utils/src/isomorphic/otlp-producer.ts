import { Layer, Redacted } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { OtlpLogger, OtlpSerialization, OtlpTracer } from 'effect/observability'

import type { CliBuildIdentity } from '../node/cli-version.ts'

/** Transport selection is explicit. Fabric is a local dial listener, not an SDK protocol. */
export type ProducerTransport =
  | {
      readonly kind: 'https'
      readonly endpoint: string
      readonly access: {
        readonly clientId: Redacted.Redacted<string>
        readonly clientSecret: Redacted.Redacted<string>
      }
    }
  | { readonly kind: 'fabric'; readonly endpoint: string }

export interface ProducerConfig {
  readonly transport: ProducerTransport
  /** Admission maps this credential to registry identity; payload identity is not trusted. */
  readonly bearer: Redacted.Redacted<string>
}

/** Reject credential-bearing URLs and accidental public plaintext bearer delivery. */
export const producerEndpoint = (transport: ProducerTransport): string => {
  const url = new URL(transport.endpoint)
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost'
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    (transport.kind === 'https' ? url.protocol !== 'https:' : url.protocol !== 'http:' || !loopback)
  ) {
    throw new TypeError(
      'OTLP endpoint must be an HTTPS origin or a Fabric loopback HTTP origin, without credentials',
    )
  }
  return url.origin
}

/** Only transport credentials cross this seam; no tenant, namespace, site or role headers. */
export const producerHeaders = (config: ProducerConfig): Record<string, string> => ({
  authorization: `Bearer ${Redacted.value(config.bearer)}`,
  ...(config.transport.kind === 'https'
    ? {
        'CF-Access-Client-Id': Redacted.value(config.transport.access.clientId),
        'CF-Access-Client-Secret': Redacted.value(config.transport.access.clientSecret),
      }
    : {}),
})

export interface ProducerTelemetryConfig extends ProducerConfig {
  /** Diagnostic claim only; the admission registry overwrites canonical service identity. */
  readonly serviceName: string
  readonly build: Pick<CliBuildIdentity, 'machineVersion'>
}

/** Scoped trace+log exporters; no ambient OTEL endpoint lookup, metrics, or global SDK registration. */
export const producerTelemetryLayer = (config: ProducerTelemetryConfig): Layer.Layer<never> => {
  const baseUrl = producerEndpoint(config.transport)
  const common = {
    headers: producerHeaders(config),
    resource: { serviceName: config.serviceName, serviceVersion: config.build.machineVersion },
  }
  return Layer.mergeAll(
    OtlpTracer.layer({ ...common, url: `${baseUrl}/v1/traces` }),
    OtlpLogger.layer({ ...common, url: `${baseUrl}/v1/logs` }),
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
}
