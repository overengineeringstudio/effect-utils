import { Effect, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { writeStdoutLineSync } from '@overeng/tui-react/node'

import {
  ARTIFACT_LIMITS,
  ArtifactError,
  ArtifactMember,
  RetainedArtifact,
  type ArtifactSelection,
} from '../../isomorphic/Artifacts.ts'
import {
  listArtifactMembers,
  readArtifactMember,
  validateArtifactMemberPath,
} from '../ArtifactArchive.ts'
import { resolveConfig } from '../Config.ts'
import { GitHubClient } from '../GitHubClient.ts'

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Run = { repo: Schema.String, runId: Schema.Finite }
const ArtifactOutput = Schema.Union([
  Schema.Struct({
    ...Run,
    page: Schema.Finite,
    totalCount: NonNegativeInt,
    artifacts: Schema.Array(RetainedArtifact),
    hasMore: Schema.Boolean,
  }),
  Schema.Struct({ ...Run, artifact: RetainedArtifact, members: Schema.Array(ArtifactMember) }),
  Schema.Struct({
    ...Run,
    artifact: RetainedArtifact,
    content: Schema.Struct({
      path: Schema.String,
      text: Schema.String,
      decompressedBytes: NonNegativeInt,
    }),
  }),
])
export type ArtifactOutput = typeof ArtifactOutput.Type

/** One JSON document; even the final newline counts against the terminal output ceiling. */
export const renderArtifactOutput = Effect.fn('artifacts.renderOutput')(function* (
  output: ArtifactOutput,
) {
  const context = {
    repo: output.repo,
    runId: output.runId,
    artifactId: 'artifact' in output ? output.artifact.id : null,
    member: 'content' in output ? output.content.path : null,
  }
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ArtifactOutput))(output).pipe(
    Effect.mapError(
      () =>
        new ArtifactError({
          ...context,
          reason: 'invalid-selection',
          message: 'Could not encode retained artifact output',
        }),
    ),
  )
  // JSON escapes C0 itself. Escape C1, line separators, and Unicode formatting controls too.
  const escaped = encoded.replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (character) => {
    const first = '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    return character.length === 1
      ? first
      : first + '\\u' + character.charCodeAt(1).toString(16).padStart(4, '0')
  })
  if (new TextEncoder().encode(escaped).byteLength + 1 > ARTIFACT_LIMITS.outputBytes) {
    return yield* new ArtifactError({
      ...context,
      reason: 'limit-exceeded',
      message:
        'Retained artifact JSON exceeds the 256 KiB output limit (including metadata and escaping)',
    })
  }
  return escaped
})

/** Only explicit decimal run IDs are accepted: never PR, URL, branch, or latest selection. */
export const selectArtifactRun = Effect.fn('artifacts.selectRun')(function* (
  repo: string,
  run: string,
) {
  const runId = Number(run)
  const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.exec(repo)?.[0] === repo
  if (
    !validRepo ||
    /^[0-9]+$/.exec(run)?.[0] !== run ||
    !Number.isSafeInteger(runId) ||
    runId <= 0
  ) {
    return yield* new ArtifactError({
      repo: validRepo ? repo : '',
      runId: Number.isSafeInteger(runId) && runId > 0 ? runId : 0,
      artifactId: null,
      member: null,
      reason: 'invalid-selection',
      message:
        'Artifacts require a positive decimal run ID and --repo owner/name (or the first configured repository)',
    })
  }
  return { repo, runId }
})

/** Validate exact member selection before any archive download. No globbing or normalization. */
export const selectArtifactMember = Effect.fn('artifacts.selectMember')(function* (
  selection: ArtifactSelection,
  member: string,
) {
  if (!validateArtifactMemberPath(member) || member.endsWith('/')) {
    return yield* new ArtifactError({
      ...selection,
      member: null,
      reason: 'invalid-selection',
      message:
        'Select an exact safe archive file path with --member; directories, traversal, controls, and non-normalized paths are not accepted',
    })
  }
  return member
})

const runArgument = Cli.Argument.String('run').pipe(
  Cli.Argument.withDescription(
    'Explicit positive numeric workflow run ID (not a PR, URL, or latest)',
  ),
)
const repoFlag = Cli.Flag.String('repo').pipe(
  Cli.Flag.optional,
  Cli.Flag.withDescription('owner/name; defaults to the first repository from resolveConfig'),
)
const artifactFlag = Cli.Flag.Int('artifact').pipe(
  Cli.Flag.withDescription(
    'Exact positive retained artifact ID; metadata must belong to the selected run',
  ),
)
const resolveRun = Effect.fn('artifacts.resolveRun')(function* (
  run: string,
  repo: Option.Option<string>,
) {
  const selectedRepo = Option.isSome(repo)
    ? repo.value
    : ((yield* resolveConfig({})).repos[0] ?? '')
  return yield* selectArtifactRun(selectedRepo, run)
})
const resolveSelection = Effect.fn('artifacts.resolveSelection')(function* (
  run: string,
  repo: Option.Option<string>,
  artifactId: number,
) {
  const selected = yield* resolveRun(run, repo)
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
    return yield* new ArtifactError({
      ...selected,
      artifactId: null,
      member: null,
      reason: 'invalid-selection',
      message: 'Select a positive safe integer artifact ID with --artifact',
    })
  }
  return { ...selected, artifactId }
})
const printOutput = Effect.fn('artifacts.printOutput')(function* (output: ArtifactOutput) {
  const rendered = yield* renderArtifactOutput(output)
  // This is the stdout data channel, not Effect's diagnostic logger.
  yield* Effect.sync(() => writeStdoutLineSync(rendered))
})

const limits =
  'Managed GitHub auth only; read-only, in-memory ZIP inspection with no extraction or output files. Limits: 1 MiB metadata, 100 artifacts/page, pages 1–1000, 32 MiB compressed archive, 1024 entries, 1024-byte paths, 8 MiB decompressed/member, 256 KiB UTF-8 text and total escaped JSON output including metadata. Oversized output fails; never truncated. No job association is inferred.'

const listCommand = Cli.Command.make('list', {
  run: runArgument,
  repo: repoFlag,
  page: Cli.Flag.Int('page').pipe(
    Cli.Flag.withDefault(1),
    Cli.Flag.withDescription(
      'One bounded metadata page, 1–1000 (default 1); at most 100 artifacts',
    ),
  ),
}).pipe(
  Cli.Command.withHandler(({ run, repo, page }) =>
    Effect.gen(function* () {
      const selected = yield* resolveRun(run, repo)
      if (!Number.isSafeInteger(page) || page < 1 || page > ARTIFACT_LIMITS.maxPage) {
        return yield* new ArtifactError({
          ...selected,
          artifactId: null,
          member: null,
          reason: 'invalid-selection',
          message: 'Artifact page must be an integer from 1 through 1000',
        })
      }
      const github = yield* GitHubClient
      yield* printOutput(yield* github.listRetainedArtifacts({ ...selected, page }))
    }),
  ),
  Cli.Command.withDescription(
    'List one bounded page of retained artifact metadata as JSON. ' + limits,
  ),
)
const membersCommand = Cli.Command.make('members', {
  run: runArgument,
  repo: repoFlag,
  artifact: artifactFlag,
}).pipe(
  Cli.Command.withHandler(({ run, repo, artifact }) =>
    Effect.gen(function* () {
      const selection = yield* resolveSelection(run, repo, artifact)
      const github = yield* GitHubClient
      const downloaded = yield* github.downloadRetainedArtifact(selection)
      const members = yield* listArtifactMembers(downloaded.bytes, selection)
      yield* printOutput({
        repo: selection.repo,
        runId: selection.runId,
        artifact: downloaded.artifact,
        members,
      })
    }),
  ),
  Cli.Command.withDescription(
    'List safe ZIP member paths and sizes as JSON; does not extract files. ' + limits,
  ),
)
const readCommand = Cli.Command.make('read', {
  run: runArgument,
  repo: repoFlag,
  artifact: artifactFlag,
  member: Cli.Flag.String('member').pipe(
    Cli.Flag.withDescription(
      'Exact safe normalized relative file path from members (no glob, directory, or binary output)',
    ),
  ),
}).pipe(
  Cli.Command.withHandler(({ run, repo, artifact, member }) =>
    Effect.gen(function* () {
      const selection = yield* resolveSelection(run, repo, artifact)
      const path = yield* selectArtifactMember(selection, member)
      const github = yield* GitHubClient
      const downloaded = yield* github.downloadRetainedArtifact(selection)
      const content = yield* readArtifactMember(downloaded.bytes, selection, path)
      yield* printOutput({
        repo: selection.repo,
        runId: selection.runId,
        artifact: downloaded.artifact,
        content,
      })
    }),
  ),
  Cli.Command.withDescription(
    'Read one exact UTF-8 text member as JSON; binary content is rejected. ' + limits,
  ),
)

/** Read-only retained GitHub Actions artifacts; never infer an artifact's job from its name. */
export const artifactsCommand = Cli.Command.make('artifacts').pipe(
  Cli.Command.withSubcommands([listCommand, membersCommand, readCommand]),
  Cli.Command.withDescription(
    'Inspect retained GitHub Actions artifacts as bounded JSON. ' + limits,
  ),
)
