import { createHmac } from 'node:crypto'

import { gitHubBaseUrlChanged } from '@alchemy.run/github/Octokit'
import { isResolved } from 'alchemy/Diff'
import * as Provider from 'alchemy/Provider'
import { Resource } from 'alchemy/Resource'
import { Effect, Schema } from 'effect'
import { memzero } from 'libsodium-wrappers'

import {
  ActionsError,
  actionsPath,
  decodeActions,
  request,
  type ActionsScope,
} from './ActionsCommon.ts'
import type { Providers } from './Providers.ts'
import { prepareSealedBox, sealSecret } from './SealedBox.ts'
import { SecretSource, type SecretHandle } from './SecretSource.ts'

/** Source handles and the repository/environment receiving the write-only secret. */
export interface ActionsSecretProps extends ActionsScope {
  readonly name: string
  readonly value: SecretHandle
  readonly hashKey?: SecretHandle
  readonly driftMode?: 'updatedAtOnly'
  readonly baseUrl?: string
  readonly retain?: boolean
}
/** Non-secret metadata and optional keyed drift digest persisted by Alchemy. */
export interface ActionsSecretAttributes extends ActionsScope {
  readonly name: string
  readonly scope: 'repository' | 'environment'
  readonly updatedAt: string
  readonly hash?: string
  readonly hashKeyId?: string
}
/** Write-only sink: values and HMAC keys are resolved transiently, never placed in Alchemy state. */
export type ActionsSecret = Resource<
  'GitHub.ActionsSecret',
  ActionsSecretProps,
  ActionsSecretAttributes,
  never,
  Providers
>
/** Declare a reasoned secret-source handle, never a plaintext or Redacted value. */
export const ActionsSecret = Resource<ActionsSecret>('GitHub.ActionsSecret')
const metadata = Schema.Struct({ name: Schema.String, updated_at: Schema.String })
const endpoint = (p: ActionsSecretProps) =>
  `${actionsPath({ scope: p, kind: 'secrets' })}/${encodeURIComponent(p.name)}`
const readSecret = Effect.fn(function* (p: ActionsSecretProps) {
  const data = yield* request(p, 'GET', endpoint(p))
  if (data === undefined) return undefined
  const observed = yield* decodeActions({ schema: metadata, value: data })
  if (observed.name !== p.name)
    return yield* new ActionsError({
      operation: 'read',
      message: 'Actions secret name differs from the declaration.',
    })
  return {
    owner: p.owner,
    repository: p.repository,
    ...(p.environment === undefined ? {} : { environment: p.environment }),
    name: observed.name,
    scope: p.environment === undefined ? ('repository' as const) : ('environment' as const),
    updatedAt: observed.updated_at,
  }
})
const identity = Effect.fn(function* (
  olds: ActionsSecretProps | undefined,
  news: ActionsSecretProps,
) {
  if (
    olds !== undefined &&
    (endpoint(olds) !== endpoint(news) || (yield* gitHubBaseUrlChanged(olds, news)) === true)
  )
    return yield* new ActionsError({
      operation: 'identity',
      message: 'Actions secret name, scope and host are immutable; declare a new resource.',
    })
})
const usingValue = <A, E, R>({
  props,
  use,
}: {
  props: ActionsSecretProps
  use: (value: Uint8Array, hash: string | undefined) => Effect.Effect<A, E, R>
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* SecretSource
      const resolve = (handle: SecretHandle) =>
        Effect.suspend(() => source.read(handle)).pipe(
          Effect.catchCause(() =>
            Effect.fail(
              new ActionsError({
                operation: 'source',
                message: 'Secret source failed; cause withheld.',
              }),
            ),
          ),
        )
      const value = yield* Effect.acquireRelease(resolve(props.value), (bytes) =>
        Effect.sync(() => memzero(bytes)),
      )
      const key =
        props.hashKey === undefined
          ? undefined
          : yield* Effect.acquireRelease(resolve(props.hashKey), (bytes) =>
              Effect.sync(() => memzero(bytes)),
            )
      const hash =
        key === undefined
          ? undefined
          : yield* Effect.try({
              try: () => createHmac('sha256', key).update(value).digest('hex'),
              catch: () =>
                new ActionsError({
                  operation: 'hash',
                  message: 'Secret hashing failed; cause withheld.',
                }),
            })
      return yield* use(value, hash)
    }),
  )
/** Alchemy lifecycle using live metadata during diff and transient source reads. */
export const ActionsSecretProvider = Provider.succeed(ActionsSecret, {
  list: () => Effect.succeed([]),
  read: ({ olds }) => readSecret(olds),
  diff: ({ olds, news, output }) =>
    Effect.gen(function* () {
      if (isResolved(news) === false) return undefined
      yield* identity(olds, news)
      const live = yield* readSecret(news)
      if (live === undefined || output === undefined || live.updatedAt !== output.updatedAt)
        return { action: 'update' as const }
      if (news.hashKey === undefined && output.hash !== undefined)
        return { action: 'update' as const }
      if (news.driftMode === 'updatedAtOnly' || news.hashKey === undefined) return undefined
      const hash = yield* usingValue({
        props: news,
        use: (_value, digest) => Effect.succeed(digest),
      })
      if (hash !== output.hash || news.hashKey.ref !== output.hashKeyId)
        return { action: 'update' as const }
      return undefined
    }),
  reconcile: ({ olds, news }) =>
    Effect.gen(function* () {
      yield* identity(olds, news)
      const key = yield* decodeActions({
        schema: Schema.Struct({ key: Schema.String, key_id: Schema.String }),
        value: yield* request(
          news,
          'GET',
          `${actionsPath({ scope: news, kind: 'secrets' })}/public-key`,
        ),
      })
      const publicKey = yield* Effect.tryPromise({
        try: () => prepareSealedBox(key.key),
        catch: () =>
          new ActionsError({
            operation: 'seal',
            message: 'Invalid Actions public key; cause withheld.',
          }),
      })
      const hash = yield* usingValue({
        props: news,
        use: (value, digest) =>
          Effect.gen(function* () {
            const encrypted = yield* Effect.try({
              try: () => sealSecret({ plaintext: value, publicKey: publicKey }),
              catch: () =>
                new ActionsError({
                  operation: 'seal',
                  message: 'Secret encryption failed; cause withheld.',
                }),
            })
            yield* request(news, 'PUT', endpoint(news), {
              encrypted_value: encrypted,
              key_id: key.key_id,
            })
            return digest
          }),
      })
      const live = yield* readSecret(news)
      if (live === undefined)
        return yield* new ActionsError({
          operation: 'verify',
          message: 'Actions secret is missing after PUT.',
        })
      return {
        ...live,
        ...(hash === undefined || news.hashKey === undefined
          ? {}
          : { hash, hashKeyId: news.hashKey.ref }),
      }
    }),
  delete: ({ olds }) =>
    olds.retain === true
      ? Effect.void
      : request(olds, 'DELETE', endpoint(olds)).pipe(Effect.asVoid),
})
