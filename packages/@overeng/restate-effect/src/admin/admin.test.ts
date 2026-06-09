/**
 * Server-free assertions for the `./admin` management surface (decision 0018, spec
 * §12): each operation hits the right admin REST endpoint with the right method /
 * path / query params, the bearer `apiKey` rides as `Authorization: Bearer …`, the
 * typed `query` decodes rows through the caller's Schema (and FAILS with a typed
 * `AdminFailed` on a decode mismatch), and a non-OK status surfaces a
 * `RestateError`. We stub `globalThis.fetch` to capture the requests.
 */
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RestateAdmin, type RestateAdminService } from './admin.ts'

interface Captured {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

let captured: Array<Captured> = []
/* The next fetch response (status + JSON body), reset per test. */
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

const installFetch = () => {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h !== undefined) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v
    captured.push({
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
    })
    const ok = nextResponse.status >= 200 && nextResponse.status < 300
    return {
      ok,
      status: nextResponse.status,
      text: async () => JSON.stringify(nextResponse.body),
    } as Response
  })
}

const run = <A>(
  use: (admin: RestateAdminService) => Effect.Effect<A, unknown>,
  layer: Layer.Layer<RestateAdmin, unknown> = RestateAdmin.layer({
    adminUrl: 'http://localhost:9070',
  }),
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* RestateAdmin
      return yield* use(admin)
    }).pipe(Effect.provide(layer)) as Effect.Effect<A>,
  )

beforeEach(() => {
  captured = []
  nextResponse = { status: 200, body: {} }
  installFetch()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RestateAdmin invocation lifecycle', () => {
  it('cancel/kill/pause/purge → PATCH /invocations/{id}/{verb}', async () => {
    await run((a) => a.cancel('inv_1'))
    await run((a) => a.kill('inv_2'))
    await run((a) => a.pause('inv_3'))
    await run((a) => a.purge('inv_4'))
    await run((a) => a.purgeJournal('inv_5'))
    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PATCH http://localhost:9070/invocations/inv_1/cancel',
      'PATCH http://localhost:9070/invocations/inv_2/kill',
      'PATCH http://localhost:9070/invocations/inv_3/pause',
      'PATCH http://localhost:9070/invocations/inv_4/purge',
      'PATCH http://localhost:9070/invocations/inv_5/purge-journal',
    ])
  })

  it('resume threads the deployment query param', async () => {
    await run((a) => a.resume('inv_6', { deployment: 'dp_abc' }))
    expect(captured[0]!.url).toBe(
      'http://localhost:9070/invocations/inv_6/resume?deployment=dp_abc',
    )
  })

  it('restartAsNew threads from + deployment and returns the new id', async () => {
    nextResponse = { status: 200, body: { new_invocation_id: 'inv_new' } }
    const out = await run((a) => a.restartAsNew('inv_7', { from: 3, deployment: 'dp_x' }))
    expect(out).toStrictEqual({ newInvocationId: 'inv_new' })
    expect(captured[0]!.url).toBe(
      'http://localhost:9070/invocations/inv_7/restart-as-new?from=3&deployment=dp_x',
    )
  })

  it('delete → DELETE /invocations/{id}', async () => {
    await run((a) => a.delete('inv_8'))
    expect(`${captured[0]!.method} ${captured[0]!.url}`).toBe(
      'DELETE http://localhost:9070/invocations/inv_8',
    )
  })
})

describe('RestateAdmin deployments', () => {
  it('register/list/get/update hit the deployment endpoints', async () => {
    await run((a) => a.registerDeployment('http://localhost:9080', { force: true }))
    await run((a) => a.listDeployments())
    await run((a) => a.getDeployment('dp_1'))
    await run((a) => a.updateDeployment('dp_1', { additional_headers: { 'x-k': 'v' } }))
    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://localhost:9070/deployments',
      'GET http://localhost:9070/deployments',
      'GET http://localhost:9070/deployments/dp_1',
      'PATCH http://localhost:9070/deployments/dp_1',
    ])
    expect(captured[0]!.body).toStrictEqual({ uri: 'http://localhost:9080', force: true })
    expect(captured[3]!.body).toStrictEqual({ additional_headers: { 'x-k': 'v' } })
  })
})

describe('RestateAdmin introspection (typed /query)', () => {
  const Row = Schema.Struct({ id: Schema.String, status: Schema.String })

  it('POSTs the SQL to /query and decodes rows through the Schema', async () => {
    nextResponse = {
      status: 200,
      body: { rows: [{ id: 'inv_1', status: 'running' }] },
    }
    const rows = await run((a) => a.query('SELECT id, status FROM sys_invocation', Row))
    expect(rows).toStrictEqual([{ id: 'inv_1', status: 'running' }])
    expect(captured[0]!.method).toBe('POST')
    expect(captured[0]!.url).toBe('http://localhost:9070/query')
    expect(captured[0]!.body).toStrictEqual({ query: 'SELECT id, status FROM sys_invocation' })
    expect(captured[0]!.headers['accept']).toBe('application/json')
  })

  it('fails with a typed AdminFailed RestateError on a decode mismatch', async () => {
    nextResponse = { status: 200, body: { rows: [{ id: 'inv_1' }] } } // missing `status`
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const admin = yield* RestateAdmin
        return yield* admin.query('SELECT id FROM sys_invocation', Row)
      }).pipe(Effect.provide(RestateAdmin.layer({ adminUrl: 'http://localhost:9070' }))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) {
      /* The failure is a RestateError with reason AdminFailed (decode arm). */
      expect(Cause.pretty(exit.cause)).toContain('AdminFailed')
    }
  })

  it('surfaces a non-OK admin status as a RestateError', async () => {
    nextResponse = { status: 500, body: { message: 'boom' } }
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const admin = yield* RestateAdmin
        return yield* admin.cancel('inv_x')
      }).pipe(Effect.provide(RestateAdmin.layer({ adminUrl: 'http://localhost:9070' }))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) === true) {
      expect(Cause.pretty(exit.cause)).toContain('AdminFailed')
    }
  })
})

describe('RestateAdmin auth + config', () => {
  it('layer({ apiKey }) sends Authorization: Bearer on every request', async () => {
    await run(
      (a) => a.cancel('inv_1'),
      RestateAdmin.layer({
        adminUrl: 'http://localhost:9070',
        apiKey: Redacted.make('secret-key'),
      }),
    )
    expect(captured[0]!.headers['authorization']).toBe('Bearer secret-key')
  })

  it('layerConfig reads RESTATE_ADMIN_URL / RESTATE_ADMIN_KEY', async () => {
    const provider = ConfigProvider.fromMap(
      new Map([
        ['RESTATE_ADMIN_URL', 'http://admin.local:9070'],
        ['RESTATE_ADMIN_KEY', 'k3y'],
      ]),
    )
    await run(
      (a) => a.cancel('inv_1'),
      RestateAdmin.layerConfig().pipe(Layer.provide(Layer.setConfigProvider(provider))),
    )
    expect(captured[0]!.url).toBe('http://admin.local:9070/invocations/inv_1/cancel')
    expect(captured[0]!.headers['authorization']).toBe('Bearer k3y')
  })
})
