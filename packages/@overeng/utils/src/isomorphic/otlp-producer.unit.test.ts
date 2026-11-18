import { Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { cloudflareDestinationProps } from './otlp-cloudflare.ts'
import { type ProducerConfig, producerEndpoint, producerHeaders } from './otlp-producer.ts'

const config = {
  bearer: Redacted.make('test-only-bearer'),
  transport: {
    kind: 'https',
    endpoint: 'https://ingest.example.com',
    access: { clientId: Redacted.make('test-id'), clientSecret: Redacted.make('test-secret') },
  },
} as const satisfies ProducerConfig

describe('producer admission transport', () => {
  it('declares independent native trace/log destinations without identity claims', () => {
    const props = cloudflareDestinationProps('example-prod-api', config)
    expect(
      Object.fromEntries(
        Object.entries(props.traces.headers).map(([key, value]) => [key, Redacted.value(value)]),
      ),
    ).toEqual({
      authorization: 'Bearer test-only-bearer',
      'CF-Access-Client-Id': 'test-id',
      'CF-Access-Client-Secret': 'test-secret',
    })
    expect(props.traces).toEqual({
      name: 'example-prod-api-traces',
      url: 'https://ingest.example.com/v1/traces',
      headers: props.traces.headers,
      logpushDataset: 'opentelemetry-traces',
      skipPreflightCheck: true,
    })
    expect(props.logs).toEqual({
      ...props.traces,
      name: 'example-prod-api-logs',
      url: 'https://ingest.example.com/v1/logs',
      logpushDataset: 'opentelemetry-logs',
    })
  })

  it('uses bearer-only auth at the Fabric local HTTP dial listener', () => {
    const fabric = {
      ...config,
      transport: { kind: 'fabric', endpoint: 'http://127.0.0.1:4318' },
    } as const
    expect(producerEndpoint(fabric.transport)).toBe('http://127.0.0.1:4318')
    expect(producerHeaders(fabric)).toEqual({ authorization: 'Bearer test-only-bearer' })
  })

  it.each([
    'http://ingest.example.com',
    'https://user:pass@ingest.example.com',
    'https://ingest.example.com/v1/traces',
    'https://ingest.example.com/?token=x',
    'https://ingest.example.com/#token',
  ])('rejects unsafe HTTPS endpoint %s', (endpoint) => {
    expect(() => producerEndpoint({ ...config.transport, endpoint })).toThrow(TypeError)
  })

  it.each(['http://ingest.example.com:4318', 'https://127.0.0.1:4318'])(
    'rejects non-loopback Fabric endpoint %s',
    (endpoint) => {
      expect(() => producerEndpoint({ kind: 'fabric', endpoint })).toThrow(TypeError)
    },
  )
})
