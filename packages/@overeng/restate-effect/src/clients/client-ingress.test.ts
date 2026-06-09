/**
 * Server-free assertions for the ingress auth surface (decision 0016, docs/vrs/07-endpoint-deploy/spec.md §2):
 * `RestateIngress.layer({ url, apiKey })` sends the API key as an
 * `Authorization: Bearer …` header, and `RestateIngress.layerConfig` reads the URL
 * + key from `RESTATE_INGRESS_URL` / `RESTATE_INGRESS_KEY` via `Config` (the key a
 * `Config.redacted`, so it never prints). We mock `connect` to capture the
 * connection options it receives.
 */
import * as clients from '@restatedev/restate-sdk-clients'
import { ConfigProvider, Effect, Layer, Redacted } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RestateIngress } from './Client.ts'

/* Capture every `connect` options bag, then return a sentinel ingress (never
 * used — the tests only assert how the connection was configured). */
const captured: Array<{ url: string; headers?: Record<string, string> }> = []
vi.mock('@restatedev/restate-sdk-clients', async (importOriginal) => {
  const actual = await importOriginal<typeof clients>()
  return {
    ...actual,
    connect: (opts: { url: string; headers?: Record<string, string> }) => {
      captured.push(opts)
      return {} as clients.Ingress
    },
  }
})

const build = (layer: Layer.Layer<RestateIngress, unknown>): Promise<void> =>
  Effect.runPromise(Effect.scoped(Layer.build(layer)).pipe(Effect.asVoid) as Effect.Effect<void>)

describe('RestateIngress auth (decision 0016)', () => {
  beforeEach(() => {
    captured.length = 0
  })

  it('layer({ url }) connects with no auth header (unauthenticated dev ingress)', async () => {
    await build(RestateIngress.layer({ url: 'http://localhost:8080' }))
    expect(captured[0]!.url).toBe('http://localhost:8080')
    expect(captured[0]!.headers).toBeUndefined()
  })

  it('layer({ url, apiKey }) sends the key as an Authorization: Bearer header', async () => {
    await build(
      RestateIngress.layer({
        url: 'https://cloud.example/ingress',
        apiKey: Redacted.make('sk_live_secret'),
      }),
    )
    expect(captured[0]!.url).toBe('https://cloud.example/ingress')
    expect(captured[0]!.headers).toStrictEqual({ Authorization: 'Bearer sk_live_secret' })
  })

  it('layer merges extra headers, the bearer header winning', async () => {
    await build(
      RestateIngress.layer({
        url: 'https://cloud.example/ingress',
        apiKey: Redacted.make('k'),
        headers: { 'x-tenant': 't1', Authorization: 'ignored' },
      }),
    )
    expect(captured[0]!.headers).toStrictEqual({
      'x-tenant': 't1',
      Authorization: 'Bearer k',
    })
  })

  it('layerConfig reads RESTATE_INGRESS_URL + RESTATE_INGRESS_KEY from Config', async () => {
    const provider = ConfigProvider.fromMap(
      new Map([
        ['RESTATE_INGRESS_URL', 'https://cloud.example/ingress'],
        ['RESTATE_INGRESS_KEY', 'sk_from_env'],
      ]),
    )
    await build(RestateIngress.layerConfig().pipe(Layer.provide(Layer.setConfigProvider(provider))))
    expect(captured[0]!.url).toBe('https://cloud.example/ingress')
    expect(captured[0]!.headers).toStrictEqual({ Authorization: 'Bearer sk_from_env' })
  })

  it('layerConfig works without a key (unauthenticated ingress from env)', async () => {
    const provider = ConfigProvider.fromMap(
      new Map([['RESTATE_INGRESS_URL', 'http://localhost:8080']]),
    )
    await build(RestateIngress.layerConfig().pipe(Layer.provide(Layer.setConfigProvider(provider))))
    expect(captured[0]!.url).toBe('http://localhost:8080/')
    expect(captured[0]!.headers).toBeUndefined()
  })
})
