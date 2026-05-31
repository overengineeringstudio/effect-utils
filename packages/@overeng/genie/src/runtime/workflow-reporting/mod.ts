import { JSONSchema, Schema } from 'effect'

export const workflowReportRecordLineMarker = 'WORKFLOW_REPORT_V1: ' as const
export const workflowReportManagedMarker = '<!-- workflow-report:managed -->' as const
export const workflowReportStatePrefix = '<!-- workflow-report:state\n' as const
export const workflowReportStateSuffix = '\n-->' as const

const strictDecodeOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const

export const WorkflowReportNonEmptyString = Schema.String.pipe(Schema.minLength(1)).annotations({
  identifier: 'WorkflowReporting.NonEmptyString',
})
export type WorkflowReportNonEmptyString = typeof WorkflowReportNonEmptyString.Type

export const WorkflowReportIsoUtc = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
).annotations({
  identifier: 'WorkflowReporting.IsoUtc',
})
export type WorkflowReportIsoUtc = typeof WorkflowReportIsoUtc.Type

export const WorkflowReportHttpsUrl = Schema.String.pipe(
  Schema.pattern(/^https:\/\/[^\s]+$/),
).annotations({
  identifier: 'WorkflowReporting.HttpsUrl',
})
export type WorkflowReportHttpsUrl = typeof WorkflowReportHttpsUrl.Type

export const WorkflowReportStatus = Schema.Literal(
  'success',
  'failure',
  'skipped',
  'neutral',
).annotations({
  identifier: 'WorkflowReporting.Status',
})
export type WorkflowReportStatus = typeof WorkflowReportStatus.Type

export const WorkflowReportSubject = Schema.Struct({
  id: WorkflowReportNonEmptyString,
  label: Schema.optional(WorkflowReportNonEmptyString),
}).annotations({
  identifier: 'WorkflowReporting.Subject',
})
export type WorkflowReportSubject = typeof WorkflowReportSubject.Type

export const WorkflowReportLink = Schema.Struct({
  label: WorkflowReportNonEmptyString,
  url: WorkflowReportHttpsUrl,
  primary: Schema.optional(Schema.Boolean),
}).annotations({
  identifier: 'WorkflowReporting.Link',
})
export type WorkflowReportLink = typeof WorkflowReportLink.Type

export const WorkflowReportRecord = Schema.TaggedStruct('WorkflowReportRecord', {
  schemaVersion: Schema.Literal(1),
  id: WorkflowReportNonEmptyString,
  kind: WorkflowReportNonEmptyString,
  subject: WorkflowReportSubject,
  status: WorkflowReportStatus,
  title: WorkflowReportNonEmptyString,
  summary: Schema.optional(Schema.String),
  createdAtUtc: WorkflowReportIsoUtc,
  links: Schema.optional(Schema.Array(WorkflowReportLink)),
  data: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}).annotations({
  identifier: 'WorkflowReporting.Record',
})
export type WorkflowReportRecord = typeof WorkflowReportRecord.Type

export const WorkflowReportBundle = Schema.TaggedStruct('WorkflowReportBundle', {
  schemaVersion: Schema.Literal(1),
  bundleId: WorkflowReportNonEmptyString,
  generatedAtUtc: WorkflowReportIsoUtc,
  records: Schema.Array(WorkflowReportRecord),
}).annotations({
  identifier: 'WorkflowReporting.Bundle',
})
export type WorkflowReportBundle = typeof WorkflowReportBundle.Type

export const WorkflowReportManagedEntry = Schema.TaggedStruct('WorkflowReportManagedEntry', {
  entryId: WorkflowReportNonEmptyString,
  label: WorkflowReportNonEmptyString,
  createdAtUtc: WorkflowReportIsoUtc,
  records: Schema.Array(WorkflowReportRecord),
}).annotations({
  identifier: 'WorkflowReporting.ManagedEntry',
})
export type WorkflowReportManagedEntry = typeof WorkflowReportManagedEntry.Type

export const WorkflowReportManagedState = Schema.TaggedStruct('WorkflowReportManagedState', {
  schemaVersion: Schema.Literal(1),
  stateId: WorkflowReportNonEmptyString,
  timeZone: WorkflowReportNonEmptyString,
  recordOrder: Schema.Array(WorkflowReportNonEmptyString),
  entries: Schema.Array(WorkflowReportManagedEntry),
}).annotations({
  identifier: 'WorkflowReporting.ManagedState',
})
export type WorkflowReportManagedState = typeof WorkflowReportManagedState.Type

export const workflowReportRecordJsonSchema = JSONSchema.make(WorkflowReportRecord)
export const workflowReportBundleJsonSchema = JSONSchema.make(WorkflowReportBundle)
export const workflowReportManagedStateJsonSchema = JSONSchema.make(WorkflowReportManagedState)

export const decodeWorkflowReportRecord = Schema.decodeUnknownSync(
  WorkflowReportRecord,
  strictDecodeOptions,
)
export const decodeWorkflowReportBundle = Schema.decodeUnknownSync(
  WorkflowReportBundle,
  strictDecodeOptions,
)
export const decodeWorkflowReportManagedState = Schema.decodeUnknownSync(
  WorkflowReportManagedState,
  strictDecodeOptions,
)

export const decodeWorkflowReportRecordJson = Schema.decodeUnknownSync(
  Schema.parseJson(WorkflowReportRecord),
  strictDecodeOptions,
)
export const decodeWorkflowReportBundleJson = Schema.decodeUnknownSync(
  Schema.parseJson(WorkflowReportBundle),
  strictDecodeOptions,
)
export const decodeWorkflowReportManagedStateJson = Schema.decodeUnknownSync(
  Schema.parseJson(WorkflowReportManagedState),
  strictDecodeOptions,
)

export const encodeWorkflowReportRecordJson = Schema.encodeSync(
  Schema.parseJson(WorkflowReportRecord),
)
export const encodeWorkflowReportBundleJson = Schema.encodeSync(
  Schema.parseJson(WorkflowReportBundle, { space: 2 }),
)
export const encodeWorkflowReportManagedStateJson = Schema.encodeSync(
  Schema.parseJson(WorkflowReportManagedState, { space: 2 }),
)

export type ParsedWorkflowReportJsonl = {
  readonly records: readonly WorkflowReportRecord[]
  readonly markedLineCount: number
  readonly ignoredLineCount: number
}

export const encodeWorkflowReportRecordLine = (
  record: WorkflowReportRecord,
  marker = workflowReportRecordLineMarker,
) => `${marker}${encodeWorkflowReportRecordJson(record)}`

export const parseMarkedWorkflowReportJsonl = (
  source: string,
  opts: { readonly marker?: string } = {},
): ParsedWorkflowReportJsonl => {
  const marker = opts.marker ?? workflowReportRecordLineMarker
  const records: WorkflowReportRecord[] = []
  let markedLineCount = 0
  let ignoredLineCount = 0

  for (const line of source.split(/\r?\n/u)) {
    const markerIndex = line.indexOf(marker)
    if (markerIndex === -1) {
      if (line.length > 0) ignoredLineCount += 1
      continue
    }

    markedLineCount += 1
    records.push(decodeWorkflowReportRecordJson(line.slice(markerIndex + marker.length)))
  }

  return { records, markedLineCount, ignoredLineCount }
}

export const createWorkflowReportBundle = (opts: {
  readonly bundleId: string
  readonly generatedAtUtc: string
  readonly records: readonly WorkflowReportRecord[]
}): WorkflowReportBundle =>
  decodeWorkflowReportBundle({
    _tag: 'WorkflowReportBundle',
    schemaVersion: 1,
    bundleId: opts.bundleId,
    generatedAtUtc: opts.generatedAtUtc,
    records: [...opts.records],
  })

export const extractWorkflowReportManagedState = (
  body: string,
  opts: { readonly stateId?: string } = {},
): WorkflowReportManagedState | undefined => {
  const startIndex = body.indexOf(workflowReportStatePrefix)
  if (startIndex === -1) return undefined

  const stateStartIndex = startIndex + workflowReportStatePrefix.length
  const endIndex = body.indexOf(workflowReportStateSuffix, stateStartIndex)
  if (endIndex === -1) {
    throw new Error('Existing workflow report comment is missing the managed state suffix marker')
  }

  const state = decodeWorkflowReportManagedStateJson(body.slice(stateStartIndex, endIndex))
  if (opts.stateId !== undefined && state.stateId !== opts.stateId) {
    throw new Error(`Expected workflow report stateId ${opts.stateId}, got ${state.stateId}`)
  }

  return state
}

export const renderWorkflowReportManagedState = (state: WorkflowReportManagedState) =>
  [
    workflowReportManagedMarker,
    `${workflowReportStatePrefix}${encodeWorkflowReportManagedStateJson(state)}${workflowReportStateSuffix}`,
  ].join('\n')

export const deriveWorkflowReportManagedState = (opts: {
  readonly stateId: string
  readonly timeZone?: string
  readonly maxEntries?: number
  readonly priorState?: WorkflowReportManagedState
  readonly entryId: string
  readonly entryLabel: string
  readonly createdAtUtc: string
  readonly records: readonly WorkflowReportRecord[]
}): WorkflowReportManagedState => {
  if (opts.priorState !== undefined && opts.priorState.stateId !== opts.stateId) {
    throw new Error(
      `Expected prior workflow report stateId ${opts.stateId}, got ${opts.priorState.stateId}`,
    )
  }

  const maxEntries = opts.maxEntries ?? 50
  const priorState =
    opts.priorState ??
    decodeWorkflowReportManagedState({
      _tag: 'WorkflowReportManagedState',
      schemaVersion: 1,
      stateId: opts.stateId,
      timeZone: opts.timeZone ?? 'Europe/Berlin',
      recordOrder: [],
      entries: [],
    })

  const currentEntry = decodeWorkflowReportManagedState({
    ...priorState,
    recordOrder: [],
    entries: [
      {
        _tag: 'WorkflowReportManagedEntry',
        entryId: opts.entryId,
        label: opts.entryLabel,
        createdAtUtc: opts.createdAtUtc,
        records: [...opts.records],
      },
    ],
  }).entries[0]

  if (currentEntry === undefined) {
    throw new Error('Failed to derive current workflow report managed entry')
  }

  const entries = [
    currentEntry,
    ...priorState.entries.filter((entry) => entry.entryId !== opts.entryId),
  ].slice(0, maxEntries)

  const recordOrder = [
    ...new Set([
      ...opts.records.map((record) => record.subject.id),
      ...priorState.recordOrder,
      ...priorState.entries.flatMap((entry) => entry.records.map((record) => record.subject.id)),
    ]),
  ]

  return decodeWorkflowReportManagedState({
    _tag: 'WorkflowReportManagedState',
    schemaVersion: 1,
    stateId: opts.stateId,
    timeZone: priorState.timeZone,
    recordOrder,
    entries,
  })
}

const escapeMarkdownTableCell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>')

const formatTimestamp = (isoUtc: string, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(isoUtc))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`
}

const primaryLink = (record: WorkflowReportRecord) =>
  record.links?.find((link) => link.primary === true) ?? record.links?.[0]

const renderRecordTitle = (record: WorkflowReportRecord) => {
  const link = primaryLink(record)
  const title = escapeMarkdownTableCell(record.title)
  return link === undefined ? title : `[${title}](${link.url})`
}

const renderRecordSummary = (record: WorkflowReportRecord) =>
  escapeMarkdownTableCell(record.summary ?? record.status)

const renderRecordsTable = (records: readonly WorkflowReportRecord[], timeZone: string) => [
  '| Subject | Status | Report | Details | Updated |',
  '| --- | --- | --- | --- | --- |',
  ...records.map(
    (record) =>
      `| ${[
        escapeMarkdownTableCell(record.subject.label ?? record.subject.id),
        escapeMarkdownTableCell(record.status),
        renderRecordTitle(record),
        renderRecordSummary(record),
        escapeMarkdownTableCell(formatTimestamp(record.createdAtUtc, timeZone)),
      ].join(' | ')} |`,
  ),
]

export const renderWorkflowReportCommentBody = (opts: {
  readonly title: string
  readonly noRecordsMessage: string
  readonly state: WorkflowReportManagedState
  readonly includeHistory?: boolean
}) => {
  const latestBySubject = new Map<string, WorkflowReportRecord>()
  for (const entry of opts.state.entries) {
    for (const record of entry.records) {
      if (latestBySubject.has(record.subject.id) === false) {
        latestBySubject.set(record.subject.id, record)
      }
    }
  }

  const latestRecords = opts.state.recordOrder.flatMap((subjectId) => {
    const record = latestBySubject.get(subjectId)
    return record === undefined ? [] : [record]
  })

  const visibleLines =
    latestRecords.length === 0
      ? [`## ${opts.title}`, '', opts.noRecordsMessage]
      : [
          `## ${opts.title}`,
          '',
          ...renderRecordsTable(latestRecords, opts.state.timeZone),
          ...(opts.includeHistory === false
            ? []
            : [
                '',
                '<details>',
                '<summary>Report history</summary>',
                '',
                ...opts.state.entries.flatMap((entry) => [
                  `### ${escapeMarkdownTableCell(entry.label)} · ${escapeMarkdownTableCell(formatTimestamp(entry.createdAtUtc, opts.state.timeZone))}`,
                  '',
                  ...(entry.records.length === 0
                    ? [opts.noRecordsMessage]
                    : renderRecordsTable(entry.records, opts.state.timeZone)),
                  '',
                ]),
                '</details>',
              ]),
        ]

  return `${visibleLines.join('\n')}\n\n${renderWorkflowReportManagedState(opts.state)}\n`
}
