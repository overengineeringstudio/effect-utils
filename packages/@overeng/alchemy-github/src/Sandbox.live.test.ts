// Preserve the upstream engine harness's generic error/service channels.
/** @effect-diagnostics anyUnknownInErrorContext:off */
import { createHash, randomUUID } from 'node:crypto'

import {
  fromToken,
  GitHubCredentials,
  type GitHubCredentialsService,
} from '@alchemy.run/github/Credentials'
import { octokitFor } from '@alchemy.run/github/Octokit'
import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { AlchemyContext } from 'alchemy/AlchemyContext'
import * as Stack from 'alchemy/Stack'
import { Stage } from 'alchemy/Stage'
import { localState } from 'alchemy/State/LocalState'
import { isTelemetryDisabled } from 'alchemy/Telemetry/Attributes'
import { deploy, destroy, toEffect } from 'alchemy/Test/Core'
import { Effect, FileSystem, Layer, Logger, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { ActionsError } from './ActionsCommon.ts'
import { ActionsVariable } from './ActionsVariable.ts'
import { providers } from './Providers.ts'
import { SecretSource } from './SecretSource.ts'

// Test/Core installs upstream TelemetryLive during deploy/destroy. Opt out before
// building it: terminal masking cannot protect private props sent to an exporter.
process.env.ALCHEMY_TELEMETRY_DISABLED = '1'

const enabled = process.env.ALCHEMY_GITHUB_SANDBOX_LIVE === '1'
const required = [
  'ALCHEMY_GITHUB_SANDBOX_TOKEN',
  'ALCHEMY_GITHUB_SANDBOX_REPO',
  'ALCHEMY_GITHUB_SANDBOX_APP_ID',
  'ALCHEMY_GITHUB_SANDBOX_RUN_ID',
  'ALCHEMY_GITHUB_SANDBOX_SECRET_VALUE',
] as const

const inputs = Effect.sync(() => {
  const missing = required.filter((key) => (process.env[key]?.trim().length ?? 0) === 0)
  if (missing.length > 0)
    throw new Error(`Sandbox live lane requires inputs: ${missing.join(', ')}. Values withheld.`)
  const token = process.env.ALCHEMY_GITHUB_SANDBOX_TOKEN!
  const repo = process.env.ALCHEMY_GITHUB_SANDBOX_REPO!
  const appId = process.env.ALCHEMY_GITHUB_SANDBOX_APP_ID!
  const runId = process.env.ALCHEMY_GITHUB_SANDBOX_RUN_ID!
  const secret = process.env.ALCHEMY_GITHUB_SANDBOX_SECRET_VALUE!
  const [owner, repository, extra] = repo.split('/')
  if (
    owner === undefined ||
    owner === '' ||
    repository === undefined ||
    repository === '' ||
    extra !== undefined ||
    /^[^\s/]+\/[^\s/]+$/.test(repo) === false
  )
    throw new Error('ALCHEMY_GITHUB_SANDBOX_REPO must be owner/repository. Value withheld.')
  if (/^[1-9]\d*$/.test(appId) === false)
    throw new Error('ALCHEMY_GITHUB_SANDBOX_APP_ID must be a positive integer. Value withheld.')
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(runId) === false)
    throw new Error(
      'ALCHEMY_GITHUB_SANDBOX_RUN_ID must be a bounded run/attempt identifier. Value withheld.',
    )
  return { token, owner, repository, runId, secret }
})

// Only fixed operation names may enter diagnostics. Engine plans and upstream causes can
// contain private repository identities, so neither logs nor raw causes reach Vitest.
const sanitized = <A, E, R>({
  operation,
  effect,
}: {
  readonly operation: string
  readonly effect: Effect.Effect<A, E, R>
}) =>
  effect.pipe(
    Effect.catchCause(() => Effect.die(`Sandbox live ${operation} failed; details withheld.`)),
  )

const sandbox = (kind: 'variable' | 'secret' | 'labels') =>
  Effect.gen(function* () {
    const config = yield* inputs
    const fs = yield* FileSystem.FileSystem
    const directory = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: 'alchemy-github-live-' }),
      (path) =>
        sanitized({
          operation: 'local state cleanup',
          effect: fs.remove(path, { recursive: true }),
        }),
    )
    // UUID prevents simultaneous local runs, reruns and partial prior failures colliding.
    const runPrefix = createHash('sha256').update(config.runId).digest('hex').slice(0, 8)
    const prefix = `al_${runPrefix}_${randomUUID().replaceAll('-', '')}`
    const name = kind === 'labels' ? prefix.toLowerCase() : prefix.toUpperCase()
    const credentials = Layer.effect(
      GitHubCredentials,
      Effect.map(GitHubCredentials, (resolve) =>
        resolve.pipe(
          Effect.map((service) => ({
            ...service,
            octokit: (override: Parameters<GitHubCredentialsService['octokit']>[0]) => {
              const client = service.octokit(override)
              const silent = () => {}
              Object.assign(client.log, {
                debug: silent,
                info: silent,
                warn: silent,
                error: silent,
              })
              return client
            },
          })),
        ),
      ),
    ).pipe(Layer.provide(fromToken(config.token)))
    let revision = 1
    const source = Layer.succeed(SecretSource, {
      read: (handle) =>
        handle.ref === 'op://sandbox/live/value' || handle.ref === 'op://sandbox/live/hash'
          ? Effect.sync(() =>
              new TextEncoder().encode(
                handle.ref.endsWith('/hash') === true
                  ? `${config.secret}:hash`
                  : `${config.secret}:${revision}`,
              ),
            )
          : Effect.fail(
              new ActionsError({
                operation: 'live source',
                message: 'Unknown live source handle.',
              }),
            ),
    })
    // The public provider collection is used unchanged, with only its secret reader injected.
    // No PEM, secret broker, remote Alchemy state, or repository-state credentials are needed.
    const github = providers({ secretSource: source }).pipe(Layer.merge(credentials))
    const state = localState()
    const options = { state, providers: github, stage: 'sandbox', dev: false, sidecar: false }
    const compile = <A>(program: Parameters<typeof toEffect<A>>[0]) =>
      program.pipe(
        Stack.make({ name: `sandbox-${kind}-${prefix}`, state, providers: github }),
        Effect.provideService(Stage, 'sandbox'),
      )
    const run = <A>(program: Parameters<typeof toEffect<A>>[0]) =>
      toEffect(program, options).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
      )
    const request = ({
      method,
      path,
    }: {
      readonly method: 'GET' | 'DELETE'
      readonly path: string
    }) =>
      Effect.gen(function* () {
        const client = yield* octokitFor(undefined)
        return yield* Effect.tryPromise({
          try: () => client.request(`${method} ${path}`),
          catch: (error) =>
            typeof error === 'object' && error !== null && 'status' in error && error.status === 404
              ? ('missing' as const)
              : ('request' as const),
        }).pipe(
          Effect.map((response) => response.data as unknown),
          Effect.catch((error) =>
            error === 'missing'
              ? Effect.void
              : Effect.die('Sandbox API request failed; details withheld.'),
          ),
        )
      }).pipe(Effect.provide(credentials))
    const root = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`
    const path =
      kind === 'labels'
        ? `${root}/labels/${encodeURIComponent(name)}`
        : `${root}/actions/${kind === 'secret' ? 'secrets' : 'variables'}/${name}`
    // Fail closed before registering deletion: never adopt an already-existing name.
    if ((yield* request({ method: 'GET', path })) !== undefined)
      return yield* Effect.die('Sandbox resource name unexpectedly exists; no mutation attempted.')
    const scope = { owner: config.owner, repository: config.repository }
    return {
      name,
      scope,
      compile,
      run,
      request,
      path,
      updateSecret: Effect.sync(() => {
        revision++
      }),
      cleanup: <A>(program: Parameters<typeof toEffect<A>>[0]) =>
        Effect.addFinalizer(() =>
          sanitized({
            operation: 'resource cleanup',
            effect: run(destroy(options, compile(program))),
          }).pipe(
            // A reconcile can write remotely then fail before persisting its output.
            // This fallback deletes only the exact UUID name checked absent above.
            Effect.ensuring(
              sanitized({
                operation: 'fallback cleanup',
                effect: request({ method: 'DELETE', path }),
              }),
            ),
          ),
        ),
      deploy: <A>(program: Parameters<typeof toEffect<A>>[0]) =>
        run(deploy(options, compile(program))),
      destroy: <A>(program: Parameters<typeof toEffect<A>>[0]) =>
        run(destroy(options, compile(program))),
    }
  })

const quiet = Logger.layer([], { mergeWithExisting: false })
const liveTest = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Check upstream's resolved gate before any sandbox inputs or resources run.
      expect(yield* isTelemetryDisabled).toBe(true)
      return yield* program
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, quiet)))

// Runs even without live credentials, and consults the exact gate TelemetryLive uses.
it.effect('disables upstream Alchemy telemetry for the sandbox harness', () =>
  Effect.map(isTelemetryDisabled, (disabled) => {
    expect(disabled).toBe(true)
  }),
)

// Distinct from App.live.test.ts: that manual adoption gate remains read-only.
// Required App repository permissions: Variables write, Secrets write, Issues write,
// plus mandatory Metadata read. Rulesets are deliberately excluded: Administration
// write and repository-plan support would expand this sandbox's privilege contract.
describe.skipIf(enabled === false)('GitHub sandbox resource lifecycle', () => {
  it.effect(
    'creates, updates and deletes an Actions variable',
    () =>
      liveTest(
        Effect.gen(function* () {
          const f = yield* sandbox('variable')
          const program = (value: string) =>
            Effect.gen(function* () {
              const variable = yield* ActionsVariable('Variable', {
                ...f.scope,
                name: f.name,
                value,
              })
              return { name: variable.name, value: variable.value }
            })
          yield* f.cleanup(program('initial'))
          yield* sanitized({
            operation: 'variable lifecycle',
            effect: Effect.gen(function* () {
              const first = yield* f.deploy(program('initial'))
              expect(first).toEqual({ name: f.name, value: 'initial' })
              const decode = Schema.decodeUnknownEffect(
                Schema.Struct({ name: Schema.String, value: Schema.String }),
              )
              const created = yield* decode(yield* f.request({ method: 'GET', path: f.path }))
              expect(created.name === f.name && created.value === 'initial').toBe(true)
              const updated = yield* f.deploy(program('updated'))
              expect(updated).toEqual({ name: f.name, value: 'updated' })
              expect(
                (yield* decode(yield* f.request({ method: 'GET', path: f.path }))).value ===
                  'updated',
              ).toBe(true)
              yield* f.destroy(program('updated'))
              expect((yield* f.request({ method: 'GET', path: f.path })) === undefined).toBe(true)
            }),
          })
        }),
      ),
    { timeout: 120_000 },
  )
})
