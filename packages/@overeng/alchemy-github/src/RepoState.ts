import { createHash, createHmac } from 'node:crypto'

import { State, StateStoreError } from 'alchemy/State'
import { makeBucketState, type BucketObjects } from 'alchemy/State/BucketState'
import { Cause, Clock, Effect, Layer, Redacted, Schedule, Scope } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { RepoStateCredentials } from './RepoStateCredentials.ts'

const encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const hmac = ({ key, value }: { key: string | Uint8Array; value: string }): Buffer =>
  createHmac('sha256', key).update(value).digest()
const failure = (operation: string): StateStoreError =>
  new StateStoreError({ message: `GitHub repository state ${operation} failed` })

// ListObjectsV2 with encoding-type=url encodes object names, not the XML envelope.
// Only these fixed scalar tags are read; no XML entities or external resources are evaluated.
const values = ({ xml, tag }: { xml: string; tag: string }): string[] =>
  Array.from(xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')), (match) =>
    (match[1] ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (entity) => {
      switch (entity) {
        case '&amp;':
          return '&'
        case '&lt;':
          return '<'
        case '&gt;':
          return '>'
        case '&quot;':
          return '"'
        default:
          return "'"
      }
    }),
  )

/** R2-backed Alchemy state. Credentials and repository prefix come exclusively from the broker.
 * Factory shape matches Alchemy's state() stack configuration API.
 */
// @effect-diagnostics-next-line lazyEffect:off -- preserve the requested factory API, matching Alchemy state() configuration
export const githubRepoState = (): Layer.Layer<
  State,
  never,
  RepoStateCredentials | HttpClient.HttpClient
> =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const credentials = yield* RepoStateCredentials
      const client = yield* HttpClient.HttpClient
      // Bind the cached store and its lease to the engine layer, not a short request scope.
      const leaseScope = yield* Effect.scope
      const make = Effect.gen(function* () {
        const initial = yield* credentials.get.pipe(Effect.mapError(() => failure('credentials')))
        const request = Effect.fn('githubRepoState.request')(function* (
          method: 'GET' | 'PUT' | 'DELETE',
          key: string,
          query: ReadonlyArray<readonly [string, string]> = [],
          body = '',
          condition: Readonly<Record<string, string>> = {},
        ) {
          const credential = yield* credentials.get.pipe(
            Effect.mapError(() => failure('credentials')),
          )
          if (
            credential.prefix !== initial.prefix ||
            credential.bucket !== initial.bucket ||
            credential.endpoint !== initial.endpoint
          )
            return yield* failure('credential scope changed')
          const url = yield* Effect.try({
            try: () => {
              const target = new URL(credential.endpoint)
              const pathname = `${target.pathname.replace(/\/$/, '')}/${encode(credential.bucket)}/${key.split('/').map(encode).join('/')}`
              target.pathname = pathname
              // WHATWG URLs normalize both literal and percent-encoded dot segments.
              // Refuse any key whose encoded path would not survive that normalization.
              if (target.pathname !== pathname) return undefined
              target.search = query
                .map(([name, value]) => `${encode(name)}=${encode(value)}`)
                .toSorted()
                .join('&')
              return target
            },
            catch: () => failure('endpoint'),
          })
          if (url === undefined) return yield* failure('key normalization')
          const now = yield* Clock.currentTimeMillis
          const date = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '')
          const day = date.slice(0, 8)
          const digest = hash(body)
          const headers: Record<string, string> = {
            ...condition,
            host: url.host,
            'x-amz-content-sha256': digest,
            'x-amz-date': date,
            'x-amz-security-token': Redacted.value(credential.sessionToken),
          }
          const names = Object.keys(headers).toSorted()
          const signedHeaders = names.join(';')
          const canonical = [
            method,
            url.pathname,
            url.search.slice(1),
            names.map((name) => `${name}:${headers[name]?.trim().replace(/\s+/g, ' ')}\n`).join(''),
            signedHeaders,
            digest,
          ].join('\n')
          const scope = `${day}/auto/s3/aws4_request`
          const dateKey = hmac({
            key: `AWS4${Redacted.value(credential.secretAccessKey)}`,
            value: day,
          })
          const signingKey = hmac({
            key: hmac({ key: hmac({ key: dateKey, value: 'auto' }), value: 's3' }),
            value: 'aws4_request',
          })
          const signature = hmac({
            key: signingKey,
            value: `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`,
          }).toString('hex')
          headers.authorization = `AWS4-HMAC-SHA256 Credential=${Redacted.value(credential.accessKeyId)}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
          let outgoing = HttpClientRequest.make(method)(url.href).pipe(
            HttpClientRequest.setHeaders(headers),
          )
          if (method === 'PUT')
            outgoing = outgoing.pipe(HttpClientRequest.bodyText(body, 'application/json'))
          return yield* Effect.gen(function* () {
            const response = yield* client.execute(outgoing)
            if (response.status >= 300 && response.status < 400) return yield* failure('redirect')
            // Consume the response here, so request-bearing transport/decode errors cannot escape.
            const text = yield* response.text
            return { status: response.status, text, version: response.headers.etag }
          }).pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
            Effect.withTracerEnabled(false),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) === true ? Effect.interrupt : failure('request'),
            ),
          )
        })
        const list = ({ prefix, children }: { prefix: string; children: boolean }) =>
          Effect.gen(function* () {
            const result: string[] = []
            let continuation: string | undefined
            do {
              const response = yield* request('GET', '', [
                ['list-type', '2'],
                ['encoding-type', 'url'],
                ['prefix', prefix],
                ...(children === true ? [['delimiter', '/'] as const] : []),
                ...(continuation === undefined
                  ? []
                  : [['continuation-token', continuation] as const]),
              ])
              if (response.status !== 200) return yield* failure('list')
              const entries =
                children === true
                  ? Array.from(
                      response.text.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g),
                      (match) => values({ xml: match[1] ?? '', tag: 'Prefix' }),
                    ).flat()
                  : values({ xml: response.text, tag: 'Key' })
              const decoded = yield* Effect.try({
                try: () => entries.map((entry) => decodeURIComponent(entry)),
                catch: () => failure('list decoding'),
              })
              for (const entry of decoded) {
                if (
                  entry.startsWith(initial.prefix) === false ||
                  entry.startsWith(prefix) === false
                )
                  return yield* failure('list scope')
                result.push(children === true ? entry.slice(prefix.length, -1) : entry)
              }
              continuation = values({ xml: response.text, tag: 'NextContinuationToken' })[0]
              if (
                values({ xml: response.text, tag: 'IsTruncated' })[0] === 'true' &&
                continuation === undefined
              )
                return yield* failure('list pagination')
            } while (continuation !== undefined)
            return result
          })
        // oxlint-disable-next-line overeng/named-args -- implements Alchemy's BucketObjects interface
        const remove: BucketObjects['delete'] = (key, ifVersion) =>
          request(
            'DELETE',
            key,
            [],
            '',
            ifVersion === undefined ? {} : { 'if-match': ifVersion },
          ).pipe(
            Effect.flatMap((response) =>
              [200, 204, 404, 409, 412].includes(response.status) === true
                ? Effect.void
                : failure('delete'),
            ),
          )
        const objects: BucketObjects = {
          listKeys: (prefix) => list({ prefix, children: false }),
          listChildren: (prefix) => list({ prefix, children: true }),
          read: (key) =>
            request('GET', key).pipe(
              Effect.flatMap((response) => {
                if (response.status === 404) return Effect.undefined
                if (response.status !== 200 || response.version === undefined)
                  return failure('read')
                return Effect.succeed({ text: response.text, version: response.version })
              }),
            ),
          // oxlint-disable-next-line overeng/named-args -- implements Alchemy's BucketObjects interface
          write: (key, body, condition) =>
            request(
              'PUT',
              key,
              [],
              body,
              condition === undefined
                ? {}
                : 'ifAbsent' in condition
                  ? { 'if-none-match': '*' }
                  : { 'if-match': condition.ifVersion },
            ).pipe(
              Effect.filterOrFail(
                (response) => response.status !== 409,
                () => ({ _tag: 'Conflict' as const }),
              ),
              Effect.retry({
                while: (error) => error._tag === 'Conflict',
                schedule: Schedule.spaced('200 millis'),
                times: 4,
              }),
              Effect.catchTag('Conflict', () =>
                Effect.succeed({ status: 409, text: '', version: undefined }),
              ),
              Effect.flatMap((response) => {
                if (response.status === 412 || response.status === 409) return Effect.undefined
                if (
                  response.status < 200 ||
                  response.status >= 300 ||
                  response.version === undefined
                )
                  return failure('write')
                return Effect.succeed(response.version)
              }),
            ),
          delete: remove,
          deleteMany: (keys) => Effect.forEach(keys, (key) => remove(key), { discard: true }),
        }
        return yield* makeBucketState({
          id: 'github-repo',
          label: 'GitHub repository',
          prefix: initial.prefix,
          objects: Effect.succeed(objects),
        })
      })
      return yield* Effect.cached(Scope.provide(make, leaseScope).pipe(Effect.orDie))
    }),
  )
