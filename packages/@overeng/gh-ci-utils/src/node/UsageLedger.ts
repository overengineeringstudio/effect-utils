import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { hostname, homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Context, Effect, Exit, FileSystem, Layer, Logger, Schema } from 'effect'
import { HttpClient } from 'effect/http'

import type { GitHubAppRequestMetadata } from '@overeng/utils/node/github-app'

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
let warned = false
let retentionStarted = false
let pending = Promise.resolve()
let dropping = false
const warn = Effect.suspend(() => {
  if (warned === true) return Effect.void
  warned = true
  return Effect.logWarning('GitHub API usage ledger could not be written or drained').pipe(
    Effect.provideService(Logger.LogToStderr, true),
  )
})

/** Bound orderly shutdown; a stalled ledger never holds the CLI open indefinitely. */
export const flushUsageLedger = Effect.promise(() => pending).pipe(
  Effect.interruptible,
  Effect.timeoutOrElse({
    duration: '2 seconds',
    orElse: () =>
      Effect.gen(function* () {
        dropping = true
        pending = Promise.resolve()
        yield* warn
      }),
  }),
)
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

const staticRouteSegments: Readonly<Record<string, true>> = {
  repos: true,
  repositories: true,
  orgs: true,
  users: true,
  user: true,
  app: true,
  installations: true,
  access_tokens: true,
  graphql: true,
  search: true,
  actions: true,
  runs: true,
  jobs: true,
  logs: true,
  artifacts: true,
  workflows: true,
  rerun: true,
  'rerun-failed-jobs': true,
  cancel: true,
  dispatches: true,
  attempts: true,
  issues: true,
  pulls: true,
  comments: true,
  reviews: true,
  commits: true,
  compare: true,
  'check-runs': true,
  'check-suites': true,
  annotations: true,
  checks: true,
  steps: true,
  backscroll: true,
  commit: true,
  job: true,
  git: true,
  refs: true,
  ref: true,
  branches: true,
  contents: true,
  tags: true,
  releases: true,
  environments: true,
  runners: true,
  'runner-groups': true,
  labels: true,
  teams: true,
  members: true,
  collaborators: true,
  permissions: true,
  rate_limit: true,
  statuses: true,
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
  let redactTail = false
  return parts
    .map((part, index) => {
      const previous = parts[index - 1]
      if (
        previous === 'refs' ||
        previous === 'ref' ||
        previous === 'branches' ||
        previous === 'contents' ||
        previous === 'tags' ||
        previous === 'compare'
      )
        redactTail = true
      if (part === '' || part === '{owner}' || part === '{repo}') return part
      if (/^\d+$/.test(part)) return '{id}'
      if (
        redactTail === true ||
        previous === 'environments' ||
        previous === 'workflows' ||
        previous === 'commits' ||
        previous === 'commit'
      )
        return '{param}'
      return Object.hasOwn(staticRouteSegments, part) ? part : '{param}'
    })
    .join('/')
}

/** One sink shared by regular HTTP middleware and the isolated App JWT transport. */
const makeUsageLedger = Effect.fn('UsageLedger.make')(function* (authKind: 'gh-cli' | 'app') {
  const fs = yield* FileSystem.FileSystem
  const context = yield* Effect.context<never>()
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
      if (dropping === true) return
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
        if (dropping === true) return
        // Effect FileSystem lacks lstat and nonblocking/no-follow open flags.
        // Native descriptor operations prevent a FIFO or a replacement symlink from blocking open.
        const appended = yield* Effect.tryPromise(async () => {
          try {
            if ((await lstat(path)).isFile() === false) return false
          } catch (cause) {
            if (
              typeof cause !== 'object' ||
              cause === null ||
              !('code' in cause) ||
              cause.code !== 'ENOENT'
            )
              throw cause
          }
          const file = await open(
            path,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_APPEND |
              constants.O_NONBLOCK |
              constants.O_NOFOLLOW,
            0o600,
          )
          try {
            if ((await file.stat()).isFile() === false) return false
            if (dropping === true) return true
            const bytes = new TextEncoder().encode(`${encode(row)}\n`)
            return (await file.write(bytes)).bytesWritten === bytes.length
          } finally {
            await file.close()
          }
        })
        if (appended === false) yield* warn
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
      pending = pending.then(() =>
        dropping === true ? undefined : Effect.runPromiseWith(context)(write),
      )
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
