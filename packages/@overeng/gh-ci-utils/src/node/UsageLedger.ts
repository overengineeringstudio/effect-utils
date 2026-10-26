import { hostname, homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Context, Effect, Exit, FileSystem, Layer, Schema } from 'effect'
import { HttpClient } from 'effect/http'

import type { GitHubAppRequestMetadata } from '@overeng/utils/node/github-app'

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
let warned = false
let retentionStarted = false
let pending = Promise.resolve()

/** Wait for queued writes when explicitly collecting ledger evidence (not on the request path). */
export const flushUsageLedger = Effect.promise(() => pending)
const commands: Readonly<Record<string, true>> = {
  status: true,
  logs: true,
  rerun: true,
  run: true,
  cancel: true,
  runners: true,
  inspect: true,
  traces: true,
  artifacts: true,
  auth: true,
}

/** Only path structure is retained; query parameters never enter the ledger. */
export const usageRoute = (url: URL): string => {
  const parts = url.pathname.split('/')
  if (parts[1] === 'repos') {
    if (parts[2] !== undefined) parts[2] = '{owner}'
    if (parts[3] !== undefined) parts[3] = '{repo}'
  } else if (parts[1] === 'orgs' || parts[1] === 'users') {
    if (parts[2] !== undefined) parts[2] = '{owner}'
  } else if (url.hostname === 'github.com' && parts.length > 2) {
    parts[1] = '{owner}'
    parts[2] = '{repo}'
  }
  return parts
    .map((part) =>
      /^\d+$/.test(part) ||
      /^[a-f0-9]{32,40}$/i.test(part) ||
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(part)
        ? '{id}'
        : part,
    )
    .join('/')
}

/** One sink shared by regular HTTP middleware and the isolated App JWT transport. */
const makeUsageLedger = Effect.fn('UsageLedger.make')(function* (authKind: 'gh-cli' | 'app') {
  const fs = yield* FileSystem.FileSystem
  const context = yield* Effect.context<never>()
  const warn = Effect.suspend(() => {
    if (warned === true) return Effect.void
    warned = true
    // Deliberately omit the filesystem error: it can contain private paths.
    return Effect.logWarning('GitHub API usage ledger could not be written')
  })
  const record = ({
    url,
    method,
    status,
    headers,
  }: {
    url: URL
    method: string
    status: number | null
    headers: Readonly<Record<string, string>>
  }) =>
    Effect.sync(() => {
      const now = new Date()
      const day = now.toISOString().slice(0, 10)
      const override = process.env.GH_CI_UTILS_USAGE_LEDGER
      const directory = join(
        process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
        'gh-ci-utils',
      )
      const path = override ?? join(directory, `usage-${day}.jsonl`)
      const agent = process.env.FRACTAL_AGENT ?? process.env.ST_AGENT ?? null
      const conflict =
        process.env.FRACTAL_AGENT !== undefined &&
        process.env.ST_AGENT !== undefined &&
        process.env.FRACTAL_AGENT !== process.env.ST_AGENT
      const remaining = headers['x-ratelimit-remaining']
      const row = {
        schemaVersion: 1,
        ts: now.toISOString(),
        source: 'gh-ci-utils',
        host: hostname(),
        agent: conflict === true ? null : agent,
        ...(conflict === true ? { agentConflict: true } : {}),
        class:
          url.pathname === '/graphql'
            ? 'graphql'
            : url.pathname.includes('/search/')
              ? 'search'
              : url.pathname.includes('/actions/')
                ? 'actions'
                : 'core',
        method,
        route: usageRoute(url),
        status,
        ...(headers['x-ratelimit-resource'] === undefined
          ? {}
          : { rateLimitResource: headers['x-ratelimit-resource'] }),
        ...(remaining !== undefined && /^\d+$/.test(remaining)
          ? { rateLimitRemaining: Number(remaining) }
          : {}),
        authKind,
        command: process.argv.slice(2).find((arg) => Object.hasOwn(commands, arg)) ?? null,
      }
      const prune = override === undefined && retentionStarted === false
      if (prune === true) retentionStarted = true
      const write = Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(path), { recursive: true })
        yield* fs.writeFileString(path, `${encode(row)}\n`, { flag: 'a', mode: 0o600 })
        if (prune === true) {
          const cutoff = new Date(`${day}T00:00:00.000Z`).getTime() - 14 * 86400000
          for (const name of yield* fs.readDirectory(directory)) {
            const match = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
            if (match?.[1] !== undefined && Date.parse(`${match[1]}T00:00:00.000Z`) < cutoff) {
              const entry = join(directory, name)
              const stat = yield* fs.stat(entry)
              if (stat.type === 'File') yield* fs.remove(entry)
            }
          }
        }
      }).pipe(Effect.catchCause(() => warn))
      // Serialize append operations without making HTTP requests wait for filesystem I/O.
      pending = pending.then(() => Effect.runPromiseWith(context)(write))
    })
  const wrap = (client: HttpClient.HttpClient) =>
    HttpClient.make((request, url) => {
      if (url.hostname !== 'github.com' && url.hostname.endsWith('.github.com') === false) {
        return client.execute(request)
      }
      return client.execute(request).pipe(
        Effect.onExit((exit) =>
          record({
            url,
            method: request.method,
            status: Exit.isSuccess(exit) === true ? exit.value.status : null,
            headers: Exit.isSuccess(exit) === true ? exit.value.headers : {},
          }),
        ),
      )
    })
  return {
    wrap,
    observe: (metadata: GitHubAppRequestMetadata) =>
      record({
        url: new URL(metadata.path, 'https://api.github.com'),
        method: metadata.method,
        status: metadata.status,
        headers: {
          ...(metadata.rateLimitResource === undefined
            ? {}
            : { 'x-ratelimit-resource': metadata.rateLimitResource }),
          ...(metadata.rateLimitRemaining === undefined
            ? {}
            : { 'x-ratelimit-remaining': metadata.rateLimitRemaining }),
        },
      }),
  }
})

interface UsageLedgerService {
  readonly wrap: (client: HttpClient.HttpClient) => HttpClient.HttpClient
  readonly observe: (metadata: GitHubAppRequestMetadata) => Effect.Effect<void>
}

/** Best-effort process-local GitHub usage sink, including the isolated App transport. */
export class UsageLedger extends Context.Service<UsageLedger, UsageLedgerService>()(
  'gh-ci-utils/UsageLedger',
) {
  static readonly layer = (authKind: 'gh-cli' | 'app') =>
    Layer.effect(this, makeUsageLedger(authKind))
}

/** Install the ledger at a service's HTTP transport boundary. */
export const usageLedgerLayer = (authKind: 'gh-cli' | 'app') =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const ledger = yield* UsageLedger
      return ledger.wrap(yield* HttpClient.HttpClient)
    }),
  ).pipe(Layer.provide(UsageLedger.layer(authKind)))
