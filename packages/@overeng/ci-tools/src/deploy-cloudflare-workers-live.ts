import { Effect, Result, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { type CleanupResult, type DeployResultV1, VerificationFailed } from './deploy-domain.ts'

const CleanupEnvelope = Schema.fromJsonString(Schema.Struct({ success: Schema.Literal(true) }))

const cleanupVersion = Effect.fn('ci-tools.deploy.cloudflare-workers.cleanup')(function* (opts: {
  readonly result: DeployResultV1
  readonly workerName: string
  readonly accountId: string
  readonly authToken: string
  readonly apiBaseUrl: string
}) {
  // Never accept the API's "latest" or abbreviated UUID selectors for destructive cleanup.
  if (
    opts.result.deployId === undefined ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      opts.result.deployId,
    ) === false
  ) {
    return {
      _tag: 'CleanupResult',
      status: 'skipped',
      message: 'No exact uploaded Worker version UUID available for cleanup',
    } satisfies CleanupResult
  }
  const client = yield* HttpClient.HttpClient
  const path = `/accounts/${encodeURIComponent(opts.accountId)}/workers/workers/${encodeURIComponent(opts.workerName)}/versions/${encodeURIComponent(opts.result.deployId)}`
  const response = yield* client.execute(
    HttpClientRequest.delete(`${opts.apiBaseUrl.replace(/\/+$/u, '')}${path}`).pipe(
      HttpClientRequest.setHeader('Authorization', `Bearer ${opts.authToken}`),
    ),
  )
  if (response.status < 200 || response.status >= 300) {
    return {
      _tag: 'CleanupResult',
      status: 'failed',
      message: `Worker version cleanup returned HTTP ${response.status}`,
    } satisfies CleanupResult
  }
  const body = yield* response.text
  const decoded = Schema.decodeUnknownResult(CleanupEnvelope)(body)
  return {
    _tag: 'CleanupResult',
    status: Result.isSuccess(decoded) === true ? 'succeeded' : 'failed',
    message:
      Result.isSuccess(decoded) === true
        ? 'Uploaded Worker version deleted'
        : 'Worker version cleanup returned an invalid success envelope',
  } satisfies CleanupResult
})

/** Verify the uploaded marker over HTTP, then record best-effort cleanup of that exact version. */
export const verifyAndCleanupCloudflareWorkers = Effect.fn(
  'ci-tools.deploy.cloudflare-workers.live',
)(function* (opts: {
  readonly result: DeployResultV1
  readonly workerName: string
  readonly accountId: string
  readonly authToken: string
  readonly apiBaseUrl: string
  readonly verifyPath: string
  readonly expectedText: string
}) {
  let cleanup: CleanupResult = {
    _tag: 'CleanupResult',
    status: 'skipped',
    message: 'Worker version cleanup has not run',
  }
  const verify = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.get(new URL(opts.verifyPath, opts.result.finalUrl).toString()),
    )
    const text = yield* response.text
    if (response.status < 200 || response.status >= 300) {
      return yield* new VerificationFailed({
        provider: 'cloudflare-workers',
        target: opts.result.target,
        finalUrl: opts.result.finalUrl,
        transient: response.status >= 500,
        message: `Worker live marker verification returned HTTP ${response.status}`,
        diagnostics: { httpStatus: String(response.status) },
      })
    }
    if (text.includes(opts.expectedText) === false) {
      return yield* new VerificationFailed({
        provider: 'cloudflare-workers',
        target: opts.result.target,
        finalUrl: opts.result.finalUrl,
        transient: false,
        message: 'Worker live marker text from the uploaded artifact was not served',
      })
    }
  }).pipe(
    Effect.catchTag('HttpClientError', () =>
      Effect.fail(
        new VerificationFailed({
          provider: 'cloudflare-workers',
          target: opts.result.target,
          finalUrl: opts.result.finalUrl,
          transient: true,
          message: 'Worker live marker HTTP request failed',
        }),
      ),
    ),
  )
  yield* verify.pipe(
    Effect.onExit(() =>
      cleanupVersion(opts).pipe(
        Effect.timeout('30 seconds'),
        Effect.catchCause(() =>
          Effect.succeed({
            _tag: 'CleanupResult',
            status: 'failed',
            message: 'Worker version cleanup request failed',
          } satisfies CleanupResult),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            cleanup = result
          }),
        ),
      ),
    ),
    Effect.catchTag('VerificationFailed', (failure) =>
      Effect.fail(
        new VerificationFailed({
          ...failure,
          message: failure.message,
          diagnostics: {
            ...failure.diagnostics,
            cleanupStatus: cleanup.status,
            ...(cleanup.message === undefined ? {} : { cleanupMessage: cleanup.message }),
          },
        }),
      ),
    ),
  )
  return { ...opts.result, cleanup } satisfies DeployResultV1
})
