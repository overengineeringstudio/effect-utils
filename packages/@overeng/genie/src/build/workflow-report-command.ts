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
} from '../runtime/mod.ts'

const nonEmptyTextOption = (name: string, description: string) =>
  Options.text(name).pipe(Options.withDescription(description))

const optionalTextOption = (name: string, description: string) =>
  Options.text(name).pipe(Options.withDescription(description), Options.withDefault(''))

const expectString = (value: unknown, path: string) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
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
  return inputPaths.map((path, index) => expectString(path, `inputPaths[${index}]`))
}

const latestCreatedAtUtc = (
  records: readonly { readonly createdAtUtc: string }[],
  fallback: string,
) =>
  records.reduce(
    (latest, record) => (record.createdAtUtc > latest ? record.createdAtUtc : latest),
    fallback,
  )

const visibleWorkflowReportBody = (body: string, marker: string) => {
  const markerIndex = body.indexOf(marker)
  return markerIndex === -1 ? body : `${body.slice(0, markerIndex).trimEnd()}\n`
}

const writeTextFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const collectBundleCommand = Command.make(
  'collect-bundle',
  {
    bundleId: nonEmptyTextOption('bundle-id', 'Workflow report bundle identifier'),
    inputPathsJson: nonEmptyTextOption(
      'input-paths-json',
      'JSON array of marked JSONL input file paths',
    ),
    outputPath: nonEmptyTextOption('output-path', 'Path that receives the encoded bundle JSON'),
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
      writeTextFile(outputPath, encodeWorkflowReportBundleJson(bundle))
    }),
).pipe(Command.withDescription('Collect marked workflow report records into a bundle'))

const renderCommentBodyCommand = Command.make(
  'render-comment-body',
  {
    bundlePath: nonEmptyTextOption('bundle-path', 'Path to a workflow report bundle JSON file'),
    commentsPath: nonEmptyTextOption('comments-path', 'Path to a GitHub issue comments JSON array'),
    commentBodyPath: nonEmptyTextOption(
      'comment-body-path',
      'Path that receives the full managed comment body',
    ),
    summaryPath: nonEmptyTextOption('summary-path', 'Path that receives the visible summary body'),
    title: nonEmptyTextOption('title', 'Markdown title for the report comment'),
    noRecordsMessage: nonEmptyTextOption(
      'no-records-message',
      'Message rendered when the report bundle has no records',
    ),
    stateId: nonEmptyTextOption('state-id', 'Stable managed state identifier'),
    entryId: nonEmptyTextOption('entry-id', 'Current report history entry identifier'),
    entryLabel: nonEmptyTextOption('entry-label', 'Current report history entry label'),
    createdAtUtc: optionalTextOption(
      'created-at-utc',
      'Current report history entry timestamp, defaults to latest record timestamp',
    ),
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
          optionalString(createdAtUtc) ?? latestCreatedAtUtc(bundle.records, bundle.generatedAtUtc),
        records: bundle.records,
      })
      const body = renderWorkflowReportCommentBody({ title, noRecordsMessage, state })

      writeTextFile(commentBodyPath, body)
      writeTextFile(summaryPath, visibleWorkflowReportBody(body, managedMarker))
    }),
).pipe(Command.withDescription('Render a managed workflow report comment body'))

const findCommentCommand = Command.make(
  'find-comment',
  {
    commentsPath: nonEmptyTextOption('comments-path', 'Path to a GitHub issue comments JSON array'),
    commentBodyPath: nonEmptyTextOption('comment-body-path', 'Path to the target comment body'),
    commentIdPath: nonEmptyTextOption(
      'comment-id-path',
      'Path that receives the existing managed comment id, or an empty string',
    ),
    stateId: nonEmptyTextOption('state-id', 'Stable managed state identifier'),
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
      writeTextFile(commentIdPath, existingComment?.id ?? '')
    }),
).pipe(Command.withDescription('Find the existing managed workflow report comment'))

export const workflowReportCommand = Command.make('workflow-report').pipe(
  Command.withSubcommands([collectBundleCommand, renderCommentBodyCommand, findCommentCommand]),
  Command.withDescription('Workflow report bundle, render, and comment-state helpers'),
)
