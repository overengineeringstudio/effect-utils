import { gitHubBaseUrlChanged } from '@alchemy.run/github/Octokit'
import { isResolved } from 'alchemy/Diff'
import * as Provider from 'alchemy/Provider'
import { Resource } from 'alchemy/Resource'
import { Effect, FileSystem, Schema } from 'effect'

import { request } from './ActionsCommon.ts'
import type { Providers } from './Providers.ts'

/** A repository label; colors omit the leading #. */
export const LabelDefinitionSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  color: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{6}$/)),
  description: Schema.optional(Schema.String),
})
/** A desired or last-applied label definition. */
export type LabelDefinition = typeof LabelDefinitionSchema.Type
/** File contract for .github/labels.json; unrelated file metadata is ignored. */
export const LabelsFileSchema = Schema.Struct({ labels: Schema.Array(LabelDefinitionSchema) })
/** Typed label configuration and API failure without upstream request/response causes. */
export class LabelsError extends Schema.TaggedError<LabelsError>()('GitHubLabelsError', {
  operation: Schema.String,
  message: Schema.String,
}) {}
/** Load the labels array from a caller-selected JSON file. */
export const loadLabelsFile = Effect.fn('GitHub.Labels.loadFile')(function* (
  path = '.github/labels.json',
) {
  const fs = yield* FileSystem.FileSystem
  const contents = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        () => new LabelsError({ operation: 'load', message: 'Cannot read labels file.' }),
      ),
    )
  const file = yield* Schema.decodeEffect(Schema.fromJsonString(LabelsFileSchema))(contents).pipe(
    Effect.mapError(() => new LabelsError({ operation: 'load', message: 'Invalid labels file.' })),
  )
  return file.labels
})
/** Desired repository label set. Removal of unmanaged labels requires explicit opt-in. */
export interface LabelsProps {
  readonly owner: string
  readonly repo: string
  readonly labels: ReadonlyArray<LabelDefinition>
  readonly deleteUnmanaged?: boolean
  readonly baseUrl?: string
}
/** Ownership receipt: only managed labels and their last-applied values are persisted. */
export interface LabelsAttributes {
  readonly managed: ReadonlyArray<LabelDefinition>
}
/** Manage repository label definitions, never label assignments to issues or pull requests. */
export type Labels = Resource<'GitHub.Labels', LabelsProps, LabelsAttributes, never, Providers>
/** Declare a managed label set; name changes are not treated as renames. */
export const Labels = Resource<Labels>('GitHub.Labels')
const key = (name: string) => name.toLowerCase()
const normalize = (label: LabelDefinition): LabelDefinition => ({
  name: label.name,
  color: label.color.toLowerCase(),
  description: label.description ?? '',
})
const same = ({ a, b }: { a: LabelDefinition; b: LabelDefinition }) =>
  key(a.name) === key(b.name) &&
  a.color.toLowerCase() === b.color.toLowerCase() &&
  (a.description ?? '') === (b.description ?? '')
const collection = (props: LabelsProps) =>
  `/repos/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repo)}/labels`
const endpoint = ({ props, name }: { props: LabelsProps; name: string }) =>
  `${collection(props)}/${encodeURIComponent(name)}`
const api = Effect.fn('GitHub.Labels.request')(function* ({
  props,
  method,
  path,
  body,
}: {
  props: LabelsProps
  method: string
  path: string
  body?: Record<string, unknown>
}) {
  return yield* request(
    {
      owner: props.owner,
      repository: props.repo,
      ...(props.baseUrl === undefined ? {} : { baseUrl: props.baseUrl }),
    },
    method,
    path,
    body,
  ).pipe(
    Effect.mapError(
      () => new LabelsError({ operation: method, message: 'GitHub labels request failed.' }),
    ),
  )
})
const desired = Effect.fn('GitHub.Labels.validate')(function* (props: LabelsProps) {
  const labels = yield* Schema.decodeEffect(Schema.Array(LabelDefinitionSchema))(props.labels).pipe(
    Effect.mapError(
      () => new LabelsError({ operation: 'validate', message: 'Invalid label definitions.' }),
    ),
  )
  if (new Set(labels.map((label) => key(label.name))).size !== labels.length)
    return yield* new LabelsError({
      operation: 'validate',
      message: 'Label names must be unique ignoring case.',
    })
  return labels.map(normalize)
})
const identity = Effect.fn('GitHub.Labels.identity')(function* (
  olds: LabelsProps | undefined,
  news: LabelsProps,
) {
  if (
    olds !== undefined &&
    (key(olds.owner) !== key(news.owner) ||
      key(olds.repo) !== key(news.repo) ||
      (yield* gitHubBaseUrlChanged(olds, news)) === true)
  )
    return yield* new LabelsError({
      operation: 'identity',
      message: 'Labels repository and host are immutable; declare a new resource.',
    })
})
const RemoteLabels = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    color: Schema.String,
    description: Schema.NullOr(Schema.String),
  }),
)
const list = Effect.fn('GitHub.Labels.list')(function* (props: LabelsProps) {
  const labels: LabelDefinition[] = []
  for (let page = 1; ; page++) {
    const data = yield* api({
      props,
      method: 'GET',
      path: `${collection(props)}?per_page=100&page=${page}`,
    })
    const batch = yield* Schema.decodeUnknownEffect(RemoteLabels)(data).pipe(
      Effect.mapError(
        () => new LabelsError({ operation: 'list', message: 'Invalid GitHub labels response.' }),
      ),
    )
    labels.push(
      ...batch.map((label) => normalize({ ...label, description: label.description ?? '' })),
    )
    if (batch.length < 100) return labels
  }
})
const report = Effect.fn('GitHub.Labels.unmanaged')(function* ({
  props,
  live,
  labels,
}: {
  props: LabelsProps
  live: ReadonlyArray<LabelDefinition>
  labels: ReadonlyArray<LabelDefinition>
}) {
  const names = new Set(labels.map((label) => key(label.name)))
  const unmanaged = live.filter((label) => names.has(key(label.name)) === false)
  if (unmanaged.length > 0)
    yield* Effect.logInfo('Unmanaged repository labels', {
      owner: props.owner,
      repo: props.repo,
      names: unmanaged.map((label) => label.name),
    })
  const observed = new Map(live.map((label) => [key(label.name), label]))
  const drifted = labels.filter((label) => {
    const current = observed.get(key(label.name))
    return current === undefined || same({ a: label, b: current }) === false
  })
  if (drifted.length > 0)
    yield* Effect.logInfo('Managed repository label drift', {
      owner: props.owner,
      repo: props.repo,
      names: drifted.map((label) => label.name),
    })
  return unmanaged
})
/** Register the label-set lifecycle with upstream GitHub credentials. */
export const LabelsProvider = Provider.succeed(Labels, {
  list: () => Effect.succeed([]),
  read: ({ olds, output }) =>
    Effect.gen(function* () {
      const labels = yield* desired(olds)
      yield* report({ props: olds, live: yield* list(olds), labels })
      // Observation must not overwrite the last-applied ownership receipt used by destroy.
      return output
    }),
  diff: ({ olds, news, output }) =>
    Effect.gen(function* () {
      if (isResolved(news) === false) return undefined
      yield* identity(olds, news)
      const labels = yield* desired(news)
      const live = yield* list(news)
      const unmanaged = yield* report({ props: news, live, labels })
      const byName = new Map(live.map((label) => [key(label.name), label]))
      const applied = new Map(output?.managed.map((label) => [key(label.name), label]))
      if (
        output === undefined ||
        output.managed.length !== labels.length ||
        labels.some((label) => {
          const remote = byName.get(key(label.name))
          const previous = applied.get(key(label.name))
          return (
            remote === undefined ||
            previous === undefined ||
            same({ a: label, b: remote }) === false ||
            same({ a: label, b: previous }) === false
          )
        }) === true ||
        (news.deleteUnmanaged === true && unmanaged.length > 0)
      )
        return { action: 'update' as const }
      return undefined
    }),
  reconcile: ({ olds, news }) =>
    Effect.gen(function* () {
      yield* identity(olds, news)
      const labels = yield* desired(news)
      const live = yield* list(news)
      const byName = new Map(live.map((label) => [key(label.name), label]))
      for (const label of labels) {
        const current = byName.get(key(label.name))
        if (current === undefined)
          yield* api({ props: news, method: 'POST', path: collection(news), body: { ...label } })
        else if (same({ a: current, b: label }) === false)
          yield* api({
            props: news,
            method: 'PATCH',
            path: endpoint({ props: news, name: current.name }),
            body: { color: label.color, description: label.description ?? '' },
          })
      }
      const unmanaged = yield* report({ props: news, live, labels })
      if (news.deleteUnmanaged === true)
        for (const label of unmanaged)
          yield* api({
            props: news,
            method: 'DELETE',
            path: endpoint({ props: news, name: label.name }),
          })
      return { managed: labels }
    }),
  delete: ({ olds, output }) =>
    Effect.gen(function* () {
      const live = new Map((yield* list(olds)).map((label) => [key(label.name), label]))
      for (const applied of output.managed) {
        const current = live.get(key(applied.name))
        if (current !== undefined && same({ a: current, b: applied }) === true)
          yield* api({
            props: olds,
            method: 'DELETE',
            path: endpoint({ props: olds, name: current.name }),
          })
      }
    }),
})
