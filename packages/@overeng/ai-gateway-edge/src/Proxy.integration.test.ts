import { createHash } from 'node:crypto'
import * as Http from 'node:http'
import { join } from 'node:path'

import { NodeHttpServer, NodeServices } from '@effect/platform-node'
import { Effect, Fiber, FileSystem, Layer, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { afterEach, describe, expect, it } from 'vitest'

import { loadCases, toHttpClientResponse } from '@overeng/ai-gateway-conformance'

import { GatewayConfig, loadConfig } from './Config.ts'
import { Metrics } from './Metrics.ts'
import { makeRoutes } from './Proxy.ts'

const servers: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

const start = async (
  handler: (request: Request) => Response | Promise<Response>,
  onRequest?: () => void,
) => {
  const server = Http.createServer(async (incoming, outgoing) => {
    onRequest?.()
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value) === true) value.forEach((part) => headers.append(name, part))
        else if (value !== undefined) headers.set(name, value)
      }
      const method = incoming.method ?? 'GET'
      const request = new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
        method,
        headers,
        ...(method === 'GET' ? {} : { body: Buffer.concat(chunks).toString('utf8') }),
      })
      const response = await handler(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body !== null) for await (const chunk of response.body) outgoing.write(chunk)
      outgoing.end()
    } catch {
      outgoing.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push({
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause !== undefined ? reject(cause) : resolve())),
      ),
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
  return `http://127.0.0.1:${address.port}`
}

const gateway = async (
  upstream: string,
  consumers: GatewayConfig['consumers'] = [
    { name: 'fixture-consumer', tokenSha256: createHash('sha256').update('secret').digest('hex') },
  ],
  maxModelLabels?: number,
  maxRequestBodyBytes?: number,
  routeMaxRequestBodyBytes?: GatewayConfig['routeMaxRequestBodyBytes'],
) => {
  const { router, metrics } = makeRoutes({
    config: {
      upstream: new URL(upstream),
      consumers,
      ...(maxModelLabels === undefined ? {} : { maxModelLabels }),
      ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
      ...(routeMaxRequestBodyBytes === undefined ? {} : { routeMaxRequestBodyBytes }),
    },
  })
  const server = Http.createServer()
  const fiber = Effect.runFork(
    Layer.launch(
      HttpRouter.serve(router, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: '127.0.0.1' })),
      ),
    ),
  )
  await new Promise<void>((resolve) => {
    if (server.listening === true) resolve()
    else server.once('listening', resolve)
  })
  servers.push({
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber))
    },
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, metrics }
}

const auth = { authorization: 'Bearer secret' }

describe('consumer verifier isolation (AIG.EDGE-R01, AIG.EDGE-R05, AIG.EDGE-R06)', () => {
  it('rejects malformed, unknown and revoked bearers without revoking another consumer', async () => {
    const upstream = await start(() => Response.json({ object: 'list', data: [] }))
    const consumers = ['first', 'second'].map((name) => ({
      name,
      tokenSha256: createHash('sha256').update(`fixture-${name}`).digest('hex'),
    }))
    const before = await gateway(upstream, consumers)
    const after = await gateway(
      upstream,
      consumers.filter(({ name }) => name !== 'first'),
    )
    for (const token of ['fixture-first', 'fixture-second']) {
      const response = await fetch(`${before.url}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    for (const authorization of [
      'Bearer fixture-first',
      'Bearer unknown',
      'bearer fixture-second',
      'Bearer two tokens',
    ]) {
      const response = await fetch(`${after.url}/v1/models`, { headers: { authorization } })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        error: { type: 'authentication_error', code: null },
      })
    }
    const retained = await fetch(`${after.url}/v1/models`, {
      headers: { authorization: 'Bearer fixture-second' },
    })
    expect(retained.status).toBe(200)
    await retained.text()
    expect(after.metrics.render()).toContain(
      'requests_total{consumer="second",model="models",status="200"} 1',
    )
    expect(after.metrics.render()).not.toContain('consumer="first"')
  })

  it('emits the local 502 error envelope when the upstream transport is unavailable', async () => {
    // Reserve an ephemeral address, then close it: no host-bound port is assumed.
    const server = Http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const { url, metrics } = await gateway(`http://127.0.0.1:${address.port}`)
    const response = await fetch(`${url}/v1/models`, { headers: auth })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: { message: 'Upstream unavailable', type: 'gateway_error', code: null },
    })
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="502"} 1',
    )
  })
})

describe('authenticated request body limit (AIG.EDGE-R03, AIG.EDGE-R05, AIG.EDGE-R06)', () => {
  const body = JSON.stringify({ model: 'example', messages: [{ content: 'é' }] })
  const limit = Buffer.byteLength(body)
  const paths = ['/v1/chat/completions', '/v1/responses', '/v1/systemone', '/alpha/decisions']

  it.each(paths)('forwards exactly the byte limit unchanged on %s', async (path) => {
    const received: string[] = []
    const upstream = await start(async (request) => {
      received.push(await request.text())
      return Response.json({})
    })
    const { url } = await gateway(upstream, undefined, undefined, limit)
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: auth,
      body,
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(received).toEqual([body])
  })

  it.each(paths)('rejects declared and chunked limit+1 before completion on %s', async (path) => {
    let forwarded = 0
    const upstream = await start(
      () => Response.json({}),
      () => {
        forwarded++
      },
    )
    const { url, metrics } = await gateway(upstream, undefined, undefined, limit)
    const complete = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: auth,
      body: `${body} `,
    })
    expect(complete.status).toBe(413)
    expect(await complete.json()).toEqual({
      error: { message: 'Request body too large', type: 'gateway_error', code: null },
    })
    expect(forwarded).toBe(0)
    for (const declared of [true, false]) {
      const response = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const request = Http.request(
            `${url}${path}`,
            {
              method: 'POST',
              headers: {
                ...auth,
                ...(declared === true
                  ? { 'content-length': String(limit + 1) }
                  : { 'transfer-encoding': 'chunked' }),
              },
            },
            (response) => {
              const chunks: Buffer[] = []
              response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
              response.on('error', reject)
              response.on('end', () => {
                resolve({
                  status: response.statusCode,
                  body: Buffer.concat(chunks).toString('utf8'),
                })
                request.destroy()
              })
            },
          )
          request.on('error', reject)
          request.flushHeaders()
          if (declared === false) {
            request.write(body)
            request.write(' ')
          }
          // Leave the upload open: rejection must not wait for EOF or the declared body.
        },
      )
      expect(response.status).toBe(413)
      expect(JSON.parse(response.body)).toEqual({
        error: { message: 'Request body too large', type: 'gateway_error', code: null },
      })
      expect(forwarded).toBe(0)
    }
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="413"} 3',
    )
  })
})

describe('gateway proxy (AIG.EDGE-R02, AIG.EDGE-R03, AIG.EDGE-R04, AIG.EDGE-R05, AIG.EDGE-R06)', () => {
  it('loads a real JSON config with a string upstream URL', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ai-gateway-edge-test-' })
        const path = join(directory, 'config.json')
        const configJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          upstream: 'http://localhost',
          consumers: [
            {
              name: 'fixture-consumer',
              tokenSha256: createHash('sha256').update('secret').digest('hex'),
            },
          ],
          maxModelLabels: 2,
          maxRequestBodyBytes: 2048,
          routeMaxRequestBodyBytes: { '/v1/responses': 8388608 },
        })
        yield* fs.writeFileString(path, configJson)
        const config = yield* loadConfig(path)
        expect(config.upstream.href).toBe('http://localhost/')
        expect(config.consumers[0]?.name).toBe('fixture-consumer')
        expect(config.maxModelLabels).toBe(2)
        expect(config.maxRequestBodyBytes).toBe(2048)
        expect(config.routeMaxRequestBodyBytes).toEqual({ '/v1/responses': 8388608 })
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  })
  it('rejects unauthorized requests and passes authenticated model discovery without forwarding credentials', async () => {
    const upstream = await start((request) =>
      Response.json({
        auth: request.headers.get('authorization'),
        hop: request.headers.get('x-hop'),
      }),
    )
    const { url } = await gateway(upstream)
    const refused = await fetch(`${url}/v1/models`)
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { type: 'authentication_error' } })
    const forwarded = await new Promise<unknown>((resolve, reject) => {
      const request = Http.get(
        `${url}/v1/models`,
        { headers: { ...auth, connection: 'x-hop', 'x-hop': 'private' } },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
          response.on('error', reject)
        },
      )
      request.on('error', reject)
    })
    expect(forwarded).toEqual({ auth: null, hop: null })
  })

  it('preserves a plaintext upstream error without requiring JSON usage', async () => {
    const upstream = await start(
      () =>
        new Response('temporarily unavailable\n', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
    )
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/example' }),
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('temporarily unavailable\n')
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="503"} 1',
    )
  })

  it('accounts for authenticated malformed JSON and missing models without forwarding them', async () => {
    let forwarded = 0
    const upstream = await start(() => {
      forwarded++
      return Response.json({})
    })
    const { url, metrics } = await gateway(upstream)
    for (const body of ['{', '{"messages":[]}']) {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
      await response.text()
    }
    expect(forwarded).toBe(0)
    const rendered = metrics.render()
    expect(rendered).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="400"} 2',
    )
    expect(rendered).toContain(
      'request_duration_seconds_count{consumer="fixture-consumer",model="_rejected"} 2',
    )
    expect(rendered).toContain(
      'request_duration_seconds_bucket{consumer="fixture-consumer",model="_rejected",le="+Inf"} 2',
    )
    const sum = rendered.match(
      /request_duration_seconds_sum\{consumer="fixture-consumer",model="_rejected"\} (\S+)/,
    )
    expect(Number(sum?.[1])).toBeGreaterThan(0)
  })

  it('meters non-stream usage and injects stream usage options while preserving SSE bytes', async () => {
    const seen: unknown[] = []
    const sse =
      'data: {"choices":[],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}\n\ndata: [DONE]\n\n'
    const upstream = await start(async (request) => {
      const json = (await request.json()) as {
        stream: boolean
        stream_options?: { include_usage: boolean }
      }
      seen.push(json)
      if (json.stream === true)
        return new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(sse)
              controller.enqueue(bytes.subarray(0, 17))
              controller.enqueue(bytes.subarray(17))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      return Response.json({ usage: { prompt_tokens: 4, completion_tokens: 2 } })
    })
    const { url, metrics } = await gateway(upstream)
    const call = (stream: boolean) =>
      fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', connection: 'keep-alive' },
        body: JSON.stringify({ model: 'anthropic/example', stream }),
      })
    expect((await call(false)).status).toBe(200)
    expect(await (await call(true)).text()).toBe(sse)
    expect(seen).toEqual([
      { model: 'anthropic/example', stream: false },
      { model: 'anthropic/example', stream: true, stream_options: { include_usage: true } },
    ])
    expect(metrics.render()).toContain(
      'tokens_total{consumer="fixture-consumer",model="anthropic/example",kind="input"} 11',
    )
    expect(metrics.render()).toContain(
      'tokens_total{consumer="fixture-consumer",model="anthropic/example",kind="cached"} 2',
    )
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="anthropic/example",status="200"} 2',
    )
  })
  it('authenticates and forwards both System One wire paths, preserving their bodies and metering their usage', async () => {
    const upstream = await start(async (request) =>
      Response.json({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        submitted: await request.json(),
        usage: { input_tokens: 6, output_tokens: 4 },
      }),
    )
    const { url, metrics } = await gateway(upstream)
    for (const path of ['/v1/systemone', '/alpha/decisions']) {
      const body = {
        model: 'typesafe/decision',
        state: { context: 1 },
        questions: { choice: { type: 'choice', instructions: { options: ['yes', 'no'] } } },
      }
      const refused = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) })
      expect(refused.status).toBe(401)
      expect(await refused.json()).toMatchObject({ error: { type: 'authentication_error' } })
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        path,
        authorization: null,
        submitted: body,
        usage: { input_tokens: 6, output_tokens: 4 },
      })
    }
    expect(metrics.render()).toContain(
      'tokens_total{consumer="fixture-consumer",model="typesafe/decision",kind="input"} 12',
    )
    expect(metrics.render()).toContain(
      'tokens_total{consumer="fixture-consumer",model="typesafe/decision",kind="output"} 8',
    )
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="typesafe/decision",status="200"} 2',
    )
  })
})

describe('bounded model accounting (AIG.EDGE-R06)', () => {
  it('defaults to 64 admitted models and supports a zero-label cap', () => {
    const metrics = new Metrics()
    for (let index = 0; index < 70; index++) {
      const labels = { consumer: 'fixture-consumer', model: `fixture/model-${index}` }
      metrics.record({ labels: labels, status: 200, seconds: 0.1 })
      metrics.addTokens({ labels: labels, status: 200, kind: 'input', count: 1 })
    }
    expect(metrics.render().match(/^requests_total\{/gm)).toHaveLength(65)
    expect(metrics.render()).toContain('model="fixture/model-63"')
    expect(metrics.render()).not.toContain('model="fixture/model-64"')
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_other",status="200"} 6',
    )
    expect(metrics.render()).toContain(
      'tokens_total{consumer="fixture-consumer",model="_other",kind="input"} 6',
    )
    const zero = new Metrics(0)
    zero.record({
      labels: { consumer: 'fixture-consumer', model: 'fixture/model' },
      status: 200,
      seconds: 0.1,
    })
    expect(zero.render()).toContain('model="_other"')
    expect(zero.render()).not.toContain('model="fixture/model"')
  })

  it('buckets rejected models without consuming the configured cap or rewriting forwarded models', async () => {
    const submitted: unknown[] = []
    const upstream = await start(async (request) => {
      const body = decodeJson(await request.text())
      submitted.push(body)
      const rejected =
        typeof body === 'object' &&
        body !== null &&
        'model' in body &&
        typeof body.model === 'string' &&
        body.model.startsWith('fixture/rejected-')
      return Response.json(
        { usage: { prompt_tokens: 2, completion_tokens: 1 } },
        {
          status: rejected === true ? 429 : 200,
        },
      )
    })
    const { url, metrics } = await gateway(upstream, undefined, 2)
    const models = [
      ...Array.from({ length: 12 }, (_, index) => `fixture/rejected-${index}`),
      'fixture/first',
      'fixture/second',
      'fixture/overflow-a',
      'fixture/overflow-b',
      'fixture/first',
    ]
    for (const model of models) {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: encodeJson({ model }),
      })
      expect(response.status).toBe(model.startsWith('fixture/rejected-') === true ? 429 : 200)
      await response.text()
    }
    expect(submitted).toEqual(models.map((model) => ({ model })))
    const rendered = metrics.render()
    expect(rendered.match(/^requests_total\{/gm)).toHaveLength(4)
    expect(rendered.match(/^request_duration_seconds_count\{/gm)).toHaveLength(4)
    expect(rendered).not.toContain('model="fixture/rejected-')
    expect(rendered).not.toContain('model="fixture/overflow-')
    expect(rendered).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="429"} 12',
    )
    expect(rendered).toContain(
      'tokens_total{consumer="fixture-consumer",model="_rejected",kind="input"} 24',
    )
    expect(rendered).toContain(
      'request_duration_seconds_count{consumer="fixture-consumer",model="_rejected"} 12',
    )
    expect(rendered).toContain(
      'requests_total{consumer="fixture-consumer",model="fixture/first",status="200"} 2',
    )
    expect(rendered).toContain(
      'requests_total{consumer="fixture-consumer",model="fixture/second",status="200"} 1',
    )
    expect(rendered).toContain(
      'requests_total{consumer="fixture-consumer",model="_other",status="200"} 2',
    )
    expect(rendered).toContain(
      'tokens_total{consumer="fixture-consumer",model="_other",kind="input"} 4',
    )
    expect(rendered).toContain(
      'request_duration_seconds_count{consumer="fixture-consumer",model="_other"} 2',
    )
  })
})

describe('Responses pass-through (AIG.EDGE-R03, AIG.EDGE-R04, AIG.EDGE-R06)', () => {
  const usage = {
    input_tokens: 12,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 4 },
  }

  it('authenticates before forwarding and rejects invalid JSON or a missing model', async () => {
    let forwarded = 0
    const upstream = await start(() => {
      forwarded++
      return Response.json({})
    })
    const { url, metrics } = await gateway(upstream)
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
      const response = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers,
        body: '{"model":"fixture/model"}',
      })
      expect(response.status).toBe(401)
      await response.text()
    }
    for (const body of ['{', '{}', '{"input":"hello"}']) {
      const response = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: auth,
        body,
      })
      expect(response.status).toBe(400)
      await response.text()
    }
    expect(forwarded).toBe(0)
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="400"} 3',
    )
    expect(metrics.render()).not.toContain('tokens_total{')
  })

  it('meters a large terminal response split across transport chunks', async () => {
    const bytes = `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { output: [{ type: 'message', content: 'x'.repeat(262144) }], usage },
    })}\n\n`
    const upstream = await start(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoded = new TextEncoder().encode(bytes)
              for (let offset = 0; offset < encoded.length; offset += 8192)
                controller.enqueue(encoded.subarray(offset, offset + 8192))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: '{"model":"fixture/large","stream":true}',
    })
    expect(await response.text()).toBe(bytes)
    for (const [kind, count] of Object.entries({ input: 12, output: 7, cached: 3, reasoning: 4 }))
      expect(metrics.render()).toContain(
        `tokens_total{consumer="fixture-consumer",model="fixture/large",kind="${kind}"} ${count}`,
      )
  })

  it.each([
    ['/v1/responses', false],
    ['/v1/responses', true],
    ['/v1/chat/completions', false],
    ['/v1/chat/completions', true],
  ] as const)(
    'retains independently valid usage counts on %s (stream=%s)',
    async (path, stream) => {
      const partialUsage =
        path === '/v1/responses'
          ? {
              ...usage,
              input_tokens_details: { cached_tokens: null },
            }
          : {
              prompt_tokens: 12,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: null },
              completion_tokens_details: { reasoning_tokens: 4 },
            }
      const payload =
        stream === true && path === '/v1/responses'
          ? { type: 'response.completed', response: { usage: partialUsage } }
          : { usage: partialUsage }
      const bytes =
        stream === true ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload)
      const upstream = await start(
        () =>
          new Response(bytes, {
            headers: { 'content-type': stream === true ? 'text/event-stream' : 'application/json' },
          }),
      )
      const { url, metrics } = await gateway(upstream)
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: auth,
        body: encodeJson({ model: 'fixture/mixed', stream }),
      })
      expect(await response.text()).toBe(bytes)
      for (const [kind, count] of Object.entries({ input: 12, output: 7, reasoning: 4 }))
        expect(metrics.render()).toContain(
          `tokens_total{consumer="fixture-consumer",model="fixture/mixed",kind="${kind}"} ${count}`,
        )
      expect(metrics.render()).not.toContain('kind="cached"')
    },
  )

  it.each([
    { previous_response_id: 'resp_other' },
    { conversation: 'conv_other' },
    { conversation: null },
    { input: [{ type: 'item_reference', id: 'item_other' }] },
    { input: [{ id: 'item_other' }] },
    { input: [{ id: 'item_other', type: null }] },
    { input: [{ role: 'user', id: 'msg_other' }] },
    { input: [{ role: 'user', id: 'msg_other', content: 'hi' }] },
    { input: [{ role: null, id: 'msg_other' }] },
    { input: [{ role: 'user' }] },
    { input: [{ role: null, content: 'hi' }] },
    { input: [{ content: 'hi' }] },
    { input: [{ type: null, role: 'user', id: 'msg_other', content: 'hi' }] },
  ])('rejects server-side state references: %j', async (reference) => {
    let forwarded = 0
    const upstream = await start(() => {
      forwarded++
      return Response.json({})
    })
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: encodeJson({ model: 'fixture/model', ...reference }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          'Server-side state references are not supported; send self-contained input with encrypted reasoning items',
        type: 'gateway_error',
        code: null,
      },
    })
    expect(forwarded).toBe(0)
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="400"} 1',
    )
  })

  it('preserves stateless continuity request and JSON response bytes and meters every usage kind', async () => {
    const body =
      '{ "model": "fixture/responses", "previous_response_id": null, "store": false, "include": ["reasoning.encrypted_content"], "input": [{"role":"user","content":"hi"},{"type":"reasoning","id":"rs_fixture","encrypted_content":"opaque"},{"type":"message","id":"msg_fixture"},{"type":"function_call","id":"fc_fixture"},{"type":"function_call_output","id":"fco_fixture"}] }'
    const bytes = ` { "output": [], "usage": ${JSON.stringify(usage)} }\n`
    const upstream = await start(async (request) => {
      expect(new URL(request.url).pathname).toBe('/v1/responses')
      expect(request.headers.get('authorization')).toBeNull()
      expect(await request.text()).toBe(body)
      return new Response(bytes, { headers: { 'content-type': 'application/json' } })
    })
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: auth, body })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(bytes)
    for (const [kind, count] of Object.entries({ input: 12, output: 7, cached: 3, reasoning: 4 }))
      expect(metrics.render()).toContain(
        `tokens_total{consumer="fixture-consumer",model="fixture/responses",kind="${kind}"} ${count}`,
      )
  })

  it.each(['response.completed', 'response.incomplete', 'response.failed'])(
    'meters terminal %s exactly once without mutating streaming requests',
    async (type) => {
      const body = '{ "model": "fixture/responses", "stream": true, "input": "hello" }'
      const event = `event: ${type}\ndata: ${JSON.stringify({ type, response: { usage } })}\n\n`
      const bytes = `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { usage } })}\n\n${event}${event}`
      const upstream = await start(async (request) => {
        expect(await request.text()).toBe(body)
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoded = new TextEncoder().encode(bytes)
              controller.enqueue(encoded.subarray(0, 29))
              controller.enqueue(encoded.subarray(29))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const { url, metrics } = await gateway(upstream)
      const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: auth, body })
      expect(await response.text()).toBe(bytes)
      for (const [kind, count] of Object.entries({ input: 12, output: 7, cached: 3, reasoning: 4 }))
        expect(metrics.render()).toContain(
          `tokens_total{consumer="fixture-consumer",model="fixture/responses",kind="${kind}"} ${count}`,
        )
      expect(metrics.render()).toContain(
        'requests_total{consumer="fixture-consumer",model="fixture/responses",status="200"} 1',
      )
    },
  )

  it.each([
    '{}',
    '{"usage":{"input_tokens":"invalid"}}',
    'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
    'event: response.failed\ndata: {"type":"response.failed","response":{"usage":{"output_tokens":-1}}}\n\n',
  ])('does not invent token series for absent or malformed usage: %s', async (bytes) => {
    const upstream = await start(
      () =>
        new Response(bytes, {
          headers: {
            'content-type':
              bytes.startsWith('event:') === true ? 'text/event-stream' : 'application/json',
          },
        }),
    )
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: '{"model":"fixture/responses","stream":true}',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(bytes)
    expect(metrics.render()).not.toContain('tokens_total{')
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="fixture/responses",status="200"} 1',
    )
  })

  it('keeps errors unchanged and uses rejected model accounting', async () => {
    const upstream = await start(() => new Response('unavailable\n', { status: 503 }))
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: '{"model":"fixture/responses"}',
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('unavailable\n')
    expect(metrics.render()).toContain(
      'requests_total{consumer="fixture-consumer",model="_rejected",status="503"} 1',
    )
  })

  it('applies the Responses body override without raising the global default', async () => {
    const body = encodeJson({ model: 'fixture/responses', input: 'x'.repeat(1048576) })
    const upstream = await start(async (request) => {
      expect(await request.text()).toBe(body)
      return Response.json({})
    })
    const { url } = await gateway(upstream, undefined, undefined, undefined, {
      '/v1/responses': 2097152,
    })
    for (const [path, status] of [
      ['/v1/responses', 200],
      ['/v1/chat/completions', 413],
    ] as const) {
      const response = await fetch(`${url}${path}`, { method: 'POST', headers: auth, body })
      expect(response.status).toBe(status)
      await response.text()
    }
    expect(() =>
      Schema.decodeUnknownSync(GatewayConfig)({
        upstream,
        consumers: [],
        routeMaxRequestBodyBytes: { '/v1/responses': 0 },
      }),
    ).toThrow()
  })
})

describe('incremental SSE transport (AIG.EDGE-R04)', () => {
  it.each(['/v1/chat/completions', '/v1/responses'])(
    'delivers the first chunk before upstream EOF on %s',
    async (path) => {
      const firstEvent =
        path === '/v1/responses'
          ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\n'
          : 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
      const endEvent =
        path === '/v1/responses'
          ? 'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n'
          : 'data: [DONE]\n\n'
      const { promise: released, resolve: release } = Promise.withResolvers<void>()
      let upstreamEnded = false
      let upstreamCanceled = false
      const upstream = await start(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(firstEvent))
                void released.then(() => {
                  upstreamEnded = true
                  if (upstreamCanceled === true) return
                  controller.enqueue(new TextEncoder().encode(endEvent))
                  controller.close()
                })
              },
              cancel() {
                upstreamCanceled = true
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      )
      const { url } = await gateway(upstream)
      try {
        // If the edge buffers until upstream EOF, this real-time deadline fails
        // while the upstream is still held behind the explicit release barrier.
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: encodeJson({ model: 'fixture/stream', stream: true }),
          signal: AbortSignal.timeout(2000),
        })
        const reader = response.body?.getReader()
        expect(reader).toBeDefined()
        if (reader === undefined) throw new Error('Expected streaming response body')
        const initial: Uint8Array[] = []
        let received = 0
        while (received < Buffer.byteLength(firstEvent)) {
          const chunk = await reader.read()
          if (chunk.done === true) throw new Error('Upstream ended before its first event')
          initial.push(chunk.value)
          received += chunk.value.byteLength
        }
        expect(Buffer.concat(initial).toString('utf8')).toBe(firstEvent)
        expect(upstreamEnded).toBe(false)
        release()
        const remaining: Uint8Array[] = []
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done === true) break
          remaining.push(chunk.value)
        }
        expect(Buffer.concat(remaining).toString('utf8')).toBe(endEvent)
      } finally {
        release()
      }
    },
  )

  it.each(['/v1/chat/completions', '/v1/responses'])(
    'cancels upstream and counts one request when a client aborts mid-SSE on %s',
    async (path) => {
      const firstEvent =
        path === '/v1/responses'
          ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\n'
          : 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
      const disconnected = Promise.withResolvers<boolean>()
      let upstreamClosed = false
      const upstream = Http.createServer((incoming, outgoing) => {
        incoming.resume()
        outgoing.once('close', () => {
          upstreamClosed = true
          disconnected.resolve(outgoing.writableFinished)
        })
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
        outgoing.write(firstEvent)
        // Never end the upstream response: only cancellation can close it before
        // fixture teardown, which deliberately happens after the assertion.
      })
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      servers.push({
        stop: () =>
          new Promise<void>((resolve, reject) => {
            upstream.close((cause) => (cause !== undefined ? reject(cause) : resolve()))
            upstream.closeAllConnections()
          }),
      })
      const address = upstream.address()
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
      const { url, metrics } = await gateway(`http://127.0.0.1:${address.port}`)
      const client = new AbortController()
      try {
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: encodeJson({ model: 'fixture/stream', stream: true }),
          signal: AbortSignal.any([client.signal, AbortSignal.timeout(2000)]),
        })
        expect(response.status).toBe(200)
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error('Expected streaming response body')
        const initial: Uint8Array[] = []
        let received = 0
        while (received < Buffer.byteLength(firstEvent)) {
          const chunk = await reader.read()
          if (chunk.done === true) throw new Error('Upstream ended before the client abort')
          initial.push(chunk.value)
          received += chunk.value.byteLength
        }
        expect(Buffer.concat(initial).toString('utf8')).toBe(firstEvent)
        expect(upstreamClosed).toBe(false)
        client.abort()
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
        // Missing abort propagation fails this deadline instead of hanging or
        // accidentally passing when afterEach closes the fixture's sockets.
        const deadline = AbortSignal.timeout(2000)
        const completedNormally = await Promise.race([
          disconnected.promise,
          new Promise<never>((_, reject) => {
            deadline.addEventListener('abort', () => reject(deadline.reason), { once: true })
          }),
        ])
        expect(completedNormally).toBe(false)
        expect(upstreamClosed).toBe(true)
        expect(metrics.render()).toContain(
          'requests_total{consumer="fixture-consumer",model="fixture/stream",status="200"} 1',
        )
        expect(metrics.render()).not.toContain('tokens_total{')
      } finally {
        client.abort()
      }
    },
  )
})

const cases = await Effect.runPromise(loadCases().pipe(Effect.provide(NodeServices.layer)))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

describe('shared wire conformance through the edge (AIG.EDGE-R07)', () => {
  // Every current case has an edge-supported endpoint. Client-side validation
  // expectations remain client responsibilities; the edge preserves their bytes.
  it.each(cases)('$id', async (replayCase) => {
    const fakeResponse = toHttpClientResponse({
      case: replayCase,
      request: HttpClientRequest.get('http://upstream.example'),
    })
    const expectedBytes = await Effect.runPromise(fakeResponse.text)
    const authenticationRefusal =
      replayCase.request.auth === 'none' && replayCase.response.status === 401
    // Client fixtures may omit auth on a fake transport. The protected edge
    // projection supplies a fixture bearer except for the actual auth refusal.
    const body: Schema.JsonObject =
      replayCase.id === 'responses.missing-model-400'
        ? {}
        : {
            model: replayCase.request.match?.model ?? 'fixture/model',
            stream: replayCase.request.match?.stream ?? false,
            ...(replayCase.request.path === '/v1/responses'
              ? { input: 'Fixture request' }
              : { messages: [{ role: 'user', content: 'Fixture request' }] }),
            ...(replayCase.request.match?.responseFormat === undefined
              ? {}
              : {
                  response_format: {
                    type: replayCase.request.match.responseFormat,
                    ...(replayCase.schema === undefined
                      ? {}
                      : { json_schema: { name: 'fixture', schema: replayCase.schema } }),
                  },
                }),
            ...(replayCase.request.path === '/v1/chat/completions' &&
            replayCase.request.match?.stream === true
              ? { stream_options: { include_usage: false, fixture_option: true } }
              : {}),
            ...replayCase.request.body,
          }
    let forwarded = 0
    const upstream = await start(async (request) => {
      forwarded++
      expect(new URL(request.url).pathname).toBe(replayCase.request.path)
      expect(request.method).toBe(replayCase.request.method)
      expect(request.headers.get('authorization')).toBeNull()
      if (request.method === 'POST') {
        const submitted = decodeJson(await request.text())
        if (replayCase.request.path === '/v1/chat/completions' && body.stream === true) {
          const options = body.stream_options
          expect(submitted).toEqual({
            ...body,
            stream_options: {
              ...(typeof options === 'object' &&
              options !== null &&
              Array.isArray(options) === false
                ? options
                : {}),
              include_usage: true,
            },
          })
        } else expect(submitted).toEqual(body)
      }
      return new Response(expectedBytes, {
        status: fakeResponse.status,
        headers: fakeResponse.headers,
      })
    })
    const { url, metrics } = await gateway(upstream)
    const response = await fetch(`${url}${replayCase.request.path}`, {
      method: replayCase.request.method,
      headers: {
        'content-type': 'application/json',
        ...(authenticationRefusal === true ? {} : auth),
      },
      ...(replayCase.request.method === 'POST' ? { body: encodeJson(body) } : {}),
    })
    expect(response.status).toBe(replayCase.response.status)
    const bytes = await response.text()
    if (authenticationRefusal === true) {
      expect(forwarded).toBe(0)
      expect(decodeJson(bytes)).toMatchObject({
        error: { type: replayCase.expect.error?.type, code: null },
      })
      expect(metrics.render()).not.toContain('consumer=')
      return
    }
    expect(forwarded).toBe(
      replayCase.id === 'responses.state-reference-400' ||
        replayCase.id === 'responses.missing-model-400'
        ? 0
        : 1,
    )
    expect(bytes).toBe(expectedBytes)
    expect(response.headers.get('content-type')).toBe(fakeResponse.headers['content-type'])
    const model =
      response.status >= 200 && response.status < 300
        ? replayCase.request.method === 'GET'
          ? 'models'
          : body.model
        : '_rejected'
    expect(metrics.render()).toContain(
      `requests_total{consumer="fixture-consumer",model="${model}",status="${response.status}"} 1`,
    )
    if (replayCase.expect.usage !== undefined) {
      const usage = replayCase.expect.usage
      expect(metrics.render()).toContain(
        `tokens_total{consumer="fixture-consumer",model="${model}",kind="input"} ${usage.input}`,
      )
      expect(metrics.render()).toContain(
        `tokens_total{consumer="fixture-consumer",model="${model}",kind="output"} ${usage.output}`,
      )
      for (const kind of ['cached', 'reasoning'] as const)
        if (usage[kind] !== undefined)
          expect(metrics.render()).toContain(
            `tokens_total{consumer="fixture-consumer",model="${model}",kind="${kind}"} ${usage[kind]}`,
          )
    }
  })
})
