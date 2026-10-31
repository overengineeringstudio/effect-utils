import { effectiveGitHubBaseUrl } from '@alchemy.run/github/Octokit'
import { isResolved } from 'alchemy/Diff'
import * as Provider from 'alchemy/Provider'
import { Resource } from 'alchemy/Resource'
import { Effect, Schema } from 'effect'

import { ActionsError, actionsPath, request, type ActionsScope } from './ActionsCommon.ts'
import type { Providers } from './Providers.ts'

/** Desired nonsecret Actions variable in a repository or environment. */
export interface ActionsVariableProps extends ActionsScope {
  readonly name: string
  readonly value: string
  readonly baseUrl?: string
  readonly retain?: boolean
}
/** Persisted variable value and immutable GitHub destination metadata. */
export interface ActionsVariableAttributes extends ActionsScope {
  readonly name: string
  readonly value: string
  readonly baseUrl: string
}
/** GitHub Actions variable resource contract. */
export type ActionsVariable = Resource<
  'GitHub.ActionsVariable',
  ActionsVariableProps,
  ActionsVariableAttributes,
  never,
  Providers
>
/** Declare a repository or environment Actions variable. */
export const ActionsVariable = Resource<ActionsVariable>('GitHub.ActionsVariable')
const Metadata = Schema.Struct({ name: Schema.String, value: Schema.String })
const path = (props: ActionsVariableProps) =>
  `${actionsPath({ scope: props, kind: 'variables' })}/${encodeURIComponent(props.name.toUpperCase())}`
const identity = Effect.fn('GitHub.ActionsVariable.identity')(function* (
  props: ActionsVariableProps,
  output?: ActionsVariableAttributes,
) {
  const baseUrl = (yield* effectiveGitHubBaseUrl(props.baseUrl)) ?? 'https://api.github.com'
  if (
    output !== undefined &&
    (output.baseUrl !== baseUrl ||
      output.owner !== props.owner ||
      output.repository !== props.repository ||
      output.environment !== props.environment ||
      output.name.toUpperCase() !== props.name.toUpperCase())
  )
    return yield* new ActionsError({
      operation: 'identity',
      message:
        'Actions variable host, scope and name are immutable; declare a new resource to move it.',
    })
  return baseUrl
})
const read = Effect.fn('GitHub.ActionsVariable.read')(function* (
  props: ActionsVariableProps,
  output?: ActionsVariableAttributes,
) {
  const baseUrl = yield* identity(props, output)
  const data = yield* request(props, 'GET', path(props))
  if (data === undefined) return undefined
  const metadata = yield* Schema.decodeUnknownEffect(Metadata)(data).pipe(
    Effect.mapError(
      () =>
        new ActionsError({
          operation: 'decode',
          message: 'GitHub returned invalid Actions variable metadata.',
        }),
    ),
  )
  if (metadata.name.toUpperCase() !== props.name.toUpperCase())
    return yield* new ActionsError({
      operation: 'identity',
      message: 'GitHub returned a different Actions variable name.',
    })
  return {
    owner: props.owner,
    repository: props.repository,
    ...(props.environment === undefined ? {} : { environment: props.environment }),
    baseUrl,
    ...metadata,
    name: metadata.name.toUpperCase(),
  }
})

/** Register the Actions variable lifecycle using upstream GitHub credentials. */
export const ActionsVariableProvider = Provider.succeed(ActionsVariable, {
  list: () => Effect.succeed([]),
  read: ({ olds, output }) => read(olds, output),
  diff: ({ news, output }) =>
    Effect.gen(function* () {
      if (isResolved(news) === false) return undefined
      yield* identity(news, output)
      if (output === undefined) return undefined
      // beta84's normal plan does not refresh persisted attributes before diff.
      const live = yield* read(news, output)
      if (live === undefined || live.value !== news.value || output.value !== news.value)
        return { action: 'update' as const }
      return undefined
    }),
  reconcile: ({ news, output }) =>
    Effect.gen(function* () {
      const baseUrl = yield* identity(news, output)
      const live = yield* read(news, output)
      yield* request(
        news,
        live === undefined ? 'POST' : 'PATCH',
        live === undefined ? actionsPath({ scope: news, kind: 'variables' }) : path(news),
        { name: news.name.toUpperCase(), value: news.value },
      )
      return {
        owner: news.owner,
        repository: news.repository,
        ...(news.environment === undefined ? {} : { environment: news.environment }),
        baseUrl,
        name: news.name.toUpperCase(),
        value: news.value,
      }
    }),
  delete: ({ olds, output }) =>
    Effect.gen(function* () {
      yield* identity(olds, output)
      if (olds.retain !== true && (yield* read(olds, output)) !== undefined)
        yield* request(olds, 'DELETE', path(olds))
    }),
})
