import { octokitFor } from '@alchemy.run/github/Octokit'
import { Effect, Schema } from 'effect'

/** Repository or pre-existing environment targeted by an Actions resource. */
export interface ActionsScope {
  readonly owner: string
  readonly repository: string
  readonly environment?: string
}
/** Sanitized boundary error, without response bodies or secret-source causes. */
export class ActionsError extends Schema.TaggedError<ActionsError>()('GitHubActionsError', {
  operation: Schema.String,
  message: Schema.String,
}) {}
/** REST collection path for the selected Actions scope. */
export const actionsPath = ({
  scope,
  kind,
}: {
  scope: ActionsScope
  kind: 'secrets' | 'variables'
}): string => {
  const repo = `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repository)}`
  return `${repo}/${scope.environment === undefined ? 'actions' : `environments/${encodeURIComponent(scope.environment)}`}/${kind}`
}
/** Shared authenticated request; GET/DELETE 404 are absence, other errors are sanitized. */
export const request = Effect.fn('GitHub.Actions.request')(function* (
  props: ActionsScope & { readonly baseUrl?: string },
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const octokit = yield* octokitFor(props.baseUrl)
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        return (
          await octokit.request(`${method} ${path}`, {
            ...body,
            request: { retries: 0, redirect: 'error' },
          })
        ).data as unknown
      } catch (error) {
        if (
          (method === 'GET' || method === 'DELETE') &&
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          error.status === 404
        )
          return undefined
        throw error
      }
    },
    catch: () =>
      new ActionsError({
        operation: method,
        message: 'GitHub Actions request failed; response and cause withheld.',
      }),
  })
})
/** Decode only the explicitly allowed response metadata. */
export const decodeActions = <S extends Schema.Constraint>({
  schema,
  value,
}: {
  schema: S
  value: unknown
}) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new ActionsError({
          operation: 'decode',
          message: 'Invalid GitHub Actions metadata; response withheld.',
        }),
    ),
  )
