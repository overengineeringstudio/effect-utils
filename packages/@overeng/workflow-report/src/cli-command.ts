import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { Command, Options } from '@effect/cli'
import { Effect } from 'effect'

import {
  collectWorkflowReportBundle,
  decodeWorkflowReportBundleJson,
  deriveWorkflowReportManagedState,
  encodeWorkflowReportBundleJson,
  extractWorkflowReportManagedState,
  findWorkflowReportManagedComment,
  renderWorkflowReportCommentBody,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportManagedComment,
} from './mod.ts'

const nonEmptyTextOption = (opts: { readonly name: string; readonly description: string }) =>
  Options.text(opts.name).pipe(Options.withDescription(opts.description))

const optionalTextOption = (opts: { readonly name: string; readonly description: string }) =>
  Options.text(opts.name).pipe(Options.withDescription(opts.description), Options.withDefault(''))

const expectString = (opts: { readonly value: unknown; readonly path: string }) => {
  if (typeof opts.value !== 'string' || opts.value.length === 0) {
    throw new Error(`${opts.path} must be a non-empty string`)
  }
  return opts.value
}

const optionalString = (value: string) => (value.length === 0 ? undefined : value)

const readComments = (path: string): readonly WorkflowReportManagedComment[] => {
  const comments = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (Array.isArray(comments) === false) throw new Error('comments response must be an array')
  return comments as readonly WorkflowReportManagedComment[]
}

const readInputPaths = (inputPathsJson: string) => {
  const inputPaths = JSON.parse(inputPathsJson) as unknown
  if (Array.isArray(inputPaths) === false) {
    throw new Error('input paths JSON must decode to an array')
  }
  return inputPaths.map((path, index) =>
    expectString({ value: path, path: `inputPaths[${index}]` }),
  )
}

const latestCreatedAtUtc = (opts: {
  readonly records: readonly { readonly createdAtUtc: string }[]
  readonly fallback: string
}) =>
  opts.records.reduce(
    (latest, record) => (record.createdAtUtc > latest ? record.createdAtUtc : latest),
    opts.fallback,
  )

const visibleWorkflowReportBody = (opts: { readonly body: string; readonly marker: string }) => {
  const markerIndex = opts.body.indexOf(opts.marker)
  return markerIndex === -1 ? opts.body : `${opts.body.slice(0, markerIndex).trimEnd()}\n`
}

const writeTextFile = (opts: { readonly path: string; readonly text: string }) => {
  mkdirSync(dirname(opts.path), { recursive: true })
  writeFileSync(opts.path, opts.text)
}

const collectBundleCommand = Command.make(
  'collect-bundle',
  {
    bundleId: nonEmptyTextOption({
      name: 'bundle-id',
      description: 'Workflow report bundle identifier',
    }),
    inputPathsJson: nonEmptyTextOption({
      name: 'input-paths-json',
      description: 'JSON array of marked JSONL input file paths',
    }),
    outputPath: nonEmptyTextOption({
      name: 'output-path',
      description: 'Path that receives the encoded bundle JSON',
    }),
    recordMarker: Options.text('record-marker').pipe(
      Options.withDescription('Line marker prefix for workflow report records'),
      Options.withDefault(workflowReportRecordLineMarker),
    ),
    allowMissingInput: Options.boolean('allow-missing-input').pipe(
      Options.withDescription('Ignore missing input files'),
      Options.withDefault(false),
    ),
  },
  ({ bundleId, inputPathsJson, outputPath, recordMarker, allowMissingInput }) =>
    Effect.sync(() => {
      const sources = []
      for (const path of readInputPaths(inputPathsJson)) {
        if (existsSync(path) === false) {
          if (allowMissingInput === true) continue
          throw new Error(`workflow report input file does not exist: ${path}`)
        }
        sources.push(readFileSync(path, 'utf8'))
      }

      const bundle = collectWorkflowReportBundle({
        bundleId,
        generatedAtUtc: new Date().toISOString(),
        sources,
        marker: recordMarker,
      })
      writeTextFile({ path: outputPath, text: encodeWorkflowReportBundleJson(bundle) })
    }),
).pipe(Command.withDescription('Collect marked workflow report records into a bundle'))

const renderCommentBodyCommand = Command.make(
  'render-comment-body',
  {
    bundlePath: nonEmptyTextOption({
      name: 'bundle-path',
      description: 'Path to a workflow report bundle JSON file',
    }),
    commentsPath: nonEmptyTextOption({
      name: 'comments-path',
      description: 'Path to a GitHub issue comments JSON array',
    }),
    commentBodyPath: nonEmptyTextOption({
      name: 'comment-body-path',
      description: 'Path that receives the full managed comment body',
    }),
    summaryPath: nonEmptyTextOption({
      name: 'summary-path',
      description: 'Path that receives the visible summary body',
    }),
    title: nonEmptyTextOption({
      name: 'title',
      description: 'Markdown title for the report comment',
    }),
    noRecordsMessage: nonEmptyTextOption({
      name: 'no-records-message',
      description: 'Message rendered when the report bundle has no records',
    }),
    stateId: nonEmptyTextOption({
      name: 'state-id',
      description: 'Stable managed state identifier',
    }),
    entryId: nonEmptyTextOption({
      name: 'entry-id',
      description: 'Current report history entry identifier',
    }),
    entryLabel: nonEmptyTextOption({
      name: 'entry-label',
      description: 'Current report history entry label',
    }),
    createdAtUtc: optionalTextOption({
      name: 'created-at-utc',
      description: 'Current report history entry timestamp, defaults to latest record timestamp',
    }),
    timeZone: Options.text('time-zone').pipe(
      Options.withDescription('IANA time zone for rendered timestamps'),
      Options.withDefault('UTC'),
    ),
    managedMarker: Options.text('managed-marker').pipe(
      Options.withDescription('Managed comment marker'),
      Options.withDefault(workflowReportManagedMarker),
    ),
  },
  ({
    bundlePath,
    commentsPath,
    commentBodyPath,
    summaryPath,
    title,
    noRecordsMessage,
    stateId,
    entryId,
    entryLabel,
    createdAtUtc,
    timeZone,
    managedMarker,
  }) =>
    Effect.sync(() => {
      const bundle = decodeWorkflowReportBundleJson(readFileSync(bundlePath, 'utf8'))
      const comments = readComments(commentsPath)
      const existingComment = findWorkflowReportManagedComment(comments, {
        stateId,
        marker: managedMarker,
      })
      const state = deriveWorkflowReportManagedState({
        stateId,
        timeZone,
        ...(existingComment === undefined ? {} : { priorState: existingComment.state }),
        entryId,
        entryLabel,
        createdAtUtc:
          optionalString(createdAtUtc) ??
          latestCreatedAtUtc({ records: bundle.records, fallback: bundle.generatedAtUtc }),
        records: bundle.records,
      })
      const body = renderWorkflowReportCommentBody({ title, noRecordsMessage, state })

      writeTextFile({ path: commentBodyPath, text: body })
      writeTextFile({
        path: summaryPath,
        text: visibleWorkflowReportBody({ body, marker: managedMarker }),
      })
    }),
).pipe(Command.withDescription('Render a managed workflow report comment body'))

const findCommentCommand = Command.make(
  'find-comment',
  {
    commentsPath: nonEmptyTextOption({
      name: 'comments-path',
      description: 'Path to a GitHub issue comments JSON array',
    }),
    commentBodyPath: nonEmptyTextOption({
      name: 'comment-body-path',
      description: 'Path to the target comment body',
    }),
    commentIdPath: nonEmptyTextOption({
      name: 'comment-id-path',
      description: 'Path that receives the existing managed comment id, or an empty string',
    }),
    stateId: nonEmptyTextOption({
      name: 'state-id',
      description: 'Stable managed state identifier',
    }),
    managedMarker: Options.text('managed-marker').pipe(
      Options.withDescription('Managed comment marker'),
      Options.withDefault(workflowReportManagedMarker),
    ),
  },
  ({ commentsPath, commentBodyPath, commentIdPath, stateId, managedMarker }) =>
    Effect.sync(() => {
      const targetState = extractWorkflowReportManagedState(readFileSync(commentBodyPath, 'utf8'), {
        stateId,
      })
      if (targetState === undefined) {
        throw new Error('workflow report comment body is missing managed state')
      }
      const existingComment = findWorkflowReportManagedComment(readComments(commentsPath), {
        stateId: targetState.stateId,
        marker: managedMarker,
      })
      writeTextFile({ path: commentIdPath, text: existingComment?.id ?? '' })
    }),
).pipe(Command.withDescription('Find the existing managed workflow report comment'))

/** CLI command for collecting bundles and rendering managed workflow report comments. */
export const workflowReportCommand = Command.make('workflow-report').pipe(
  Command.withSubcommands([collectBundleCommand, renderCommentBodyCommand, findCommentCommand]),
  Command.withDescription('Workflow report bundle, render, and comment-state helpers'),
)
