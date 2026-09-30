/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Wire-contract exports mirror JSON field names; validators use value/path pairs for precise errors. */

/**
 * Bootstrap-safe workflow-report wire contract for CI (issue #884 closure).
 *
 * Constants, types, JSON schemas, decoders/encoders, and the managed-comment renderer for the
 * `WORKFLOW_REPORT_V1` protocol. This module imports NOTHING at runtime (no `effect`, no `./deploy-*`),
 * so genie generator sources can import these symbols pre-install without dragging a runtime-only
 * package into their bootstrap import closure. `mod.ts` re-exports the whole surface, so runtime
 * consumers are unaffected.
 */
export const workflowReportRecordLineMarker = 'WORKFLOW_REPORT_V1: ' as const
export const workflowReportManagedMarker = '<!-- workflow-report:managed -->' as const
export const workflowReportStatePrefix = '<!-- workflow-report:state\n' as const
export const workflowReportStateSuffix = '\n-->' as const

export type WorkflowReportStatus = 'success' | 'failure' | 'skipped' | 'neutral'

export type WorkflowReportSubject = {
  readonly id: string
  readonly label?: string
}

export type WorkflowReportLink = {
  readonly label: string
  readonly url: string
  readonly primary?: boolean
}

export type WorkflowReportRecord = {
  readonly _tag: 'WorkflowReportRecord'
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: string
  readonly subject: WorkflowReportSubject
  readonly status: WorkflowReportStatus
  readonly title: string
  readonly summary?: string
  readonly createdAtUtc: string
  readonly links?: readonly WorkflowReportLink[]
  readonly data?: Readonly<Record<string, unknown>>
}

export type WorkflowReportBundle = {
  readonly _tag: 'WorkflowReportBundle'
  readonly schemaVersion: 1
  readonly bundleId: string
  readonly generatedAtUtc: string
  readonly records: readonly WorkflowReportRecord[]
}

export type WorkflowReportManagedEntry = {
  readonly _tag: 'WorkflowReportManagedEntry'
  readonly entryId: string
  readonly label: string
  readonly createdAtUtc: string
  readonly records: readonly WorkflowReportRecord[]
}

export type WorkflowReportManagedState = {
  readonly _tag: 'WorkflowReportManagedState'
  readonly schemaVersion: 1
  readonly stateId: string
  readonly timeZone: string
  readonly recordOrder: readonly string[]
  readonly entries: readonly WorkflowReportManagedEntry[]
}

export type WorkflowReportManagedComment = {
  readonly id: string | number
  readonly body?: string | null
}

export type WorkflowReportManagedCommentMatch = {
  readonly id: string
  readonly state: WorkflowReportManagedState
}

const jsonSchemaDraft = 'http://json-schema.org/draft-07/schema#'

const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
} as const

const isoUtcStringSchema = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$',
} as const

const httpsUrlStringSchema = {
  type: 'string',
  pattern: '^https://[^\\s]+$',
} as const

const subjectSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    label: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
  },
} as const

const linkSchema = {
  type: 'object',
  required: ['label', 'url'],
  additionalProperties: false,
  properties: {
    label: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    url: { $ref: '#/$defs/WorkflowReporting.HttpsUrl' },
    primary: { type: 'boolean' },
  },
} as const

const recordSchema = {
  type: 'object',
  required: ['_tag', 'schemaVersion', 'id', 'kind', 'subject', 'status', 'title', 'createdAtUtc'],
  additionalProperties: false,
  properties: {
    _tag: { const: 'WorkflowReportRecord' },
    schemaVersion: { const: 1 },
    id: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    kind: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    subject: { $ref: '#/$defs/WorkflowReporting.Subject' },
    status: { enum: ['success', 'failure', 'skipped', 'neutral'] },
    title: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    summary: { type: 'string' },
    createdAtUtc: { $ref: '#/$defs/WorkflowReporting.IsoUtc' },
    links: {
      type: 'array',
      items: { $ref: '#/$defs/WorkflowReporting.Link' },
    },
    data: { type: 'object' },
  },
} as const

const managedEntrySchema = {
  type: 'object',
  required: ['_tag', 'entryId', 'label', 'createdAtUtc', 'records'],
  additionalProperties: false,
  properties: {
    _tag: { const: 'WorkflowReportManagedEntry' },
    entryId: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    label: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
    createdAtUtc: { $ref: '#/$defs/WorkflowReporting.IsoUtc' },
    records: {
      type: 'array',
      items: { $ref: '#/$defs/WorkflowReporting.Record' },
    },
  },
} as const

const workflowReportJsonSchemaDefs = {
  'WorkflowReporting.NonEmptyString': nonEmptyStringSchema,
  'WorkflowReporting.IsoUtc': isoUtcStringSchema,
  'WorkflowReporting.HttpsUrl': httpsUrlStringSchema,
  'WorkflowReporting.Subject': subjectSchema,
  'WorkflowReporting.Link': linkSchema,
  'WorkflowReporting.Record': recordSchema,
  'WorkflowReporting.Bundle': {
    type: 'object',
    required: ['_tag', 'schemaVersion', 'bundleId', 'generatedAtUtc', 'records'],
    additionalProperties: false,
    properties: {
      _tag: { const: 'WorkflowReportBundle' },
      schemaVersion: { const: 1 },
      bundleId: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
      generatedAtUtc: { $ref: '#/$defs/WorkflowReporting.IsoUtc' },
      records: {
        type: 'array',
        items: { $ref: '#/$defs/WorkflowReporting.Record' },
      },
    },
  },
  'WorkflowReporting.ManagedEntry': managedEntrySchema,
  'WorkflowReporting.ManagedState': {
    type: 'object',
    required: ['_tag', 'schemaVersion', 'stateId', 'timeZone', 'recordOrder', 'entries'],
    additionalProperties: false,
    properties: {
      _tag: { const: 'WorkflowReportManagedState' },
      schemaVersion: { const: 1 },
      stateId: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
      timeZone: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
      recordOrder: {
        type: 'array',
        items: { $ref: '#/$defs/WorkflowReporting.NonEmptyString' },
      },
      entries: {
        type: 'array',
        items: { $ref: '#/$defs/WorkflowReporting.ManagedEntry' },
      },
    },
  },
} as const

export const workflowReportRecordJsonSchema = {
  $schema: jsonSchemaDraft,
  $ref: '#/$defs/WorkflowReporting.Record',
  $defs: workflowReportJsonSchemaDefs,
} as const

export const workflowReportBundleJsonSchema = {
  $schema: jsonSchemaDraft,
  $ref: '#/$defs/WorkflowReporting.Bundle',
  $defs: workflowReportJsonSchemaDefs,
} as const

export const workflowReportManagedStateJsonSchema = {
  $schema: jsonSchemaDraft,
  $ref: '#/$defs/WorkflowReporting.ManagedState',
  $defs: workflowReportJsonSchemaDefs,
} as const

const workflowReportStatuses = new Set<WorkflowReportStatus>([
  'success',
  'failure',
  'skipped',
  'neutral',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

const fail = (message: string): never => {
  throw new Error(message)
}

const expectRecord = (value: unknown, path: string): Record<string, unknown> =>
  isRecord(value) === true ? value : fail(`${path} must be an object`)

const expectNonEmptyString = (value: unknown, path: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fail(`${path} must be a non-empty string`)

const expectIsoUtc = (value: unknown, path: string): string => {
  const string = expectNonEmptyString(value, path)
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(string) === false ||
    Number.isNaN(Date.parse(string)) === true
  ) {
    fail(`${path} must be an ISO UTC timestamp`)
  }
  return string
}

const expectHttpsUrl = (value: unknown, path: string): string => {
  const string = expectNonEmptyString(value, path)
  if (string.startsWith('https://') === false) fail(`${path} must be an HTTPS URL`)
  return string
}

const expectArray = (value: unknown, path: string): readonly unknown[] =>
  Array.isArray(value) === true ? value : fail(`${path} must be an array`)

const expectExactKeys = (
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
) => {
  for (const key of Object.keys(record)) {
    if (allowedKeys.includes(key) === false) fail(`${path}.${key} is not allowed`)
  }
}

const decodeSubject = (value: unknown, path: string): WorkflowReportSubject => {
  const record = expectRecord(value, path)
  expectExactKeys(record, ['id', 'label'], path)
  return {
    id: expectNonEmptyString(record.id, `${path}.id`),
    ...(record.label === undefined
      ? {}
      : { label: expectNonEmptyString(record.label, `${path}.label`) }),
  }
}

const decodeLink = (value: unknown, path: string): WorkflowReportLink => {
  const record = expectRecord(value, path)
  expectExactKeys(record, ['label', 'url', 'primary'], path)
  if (record.primary !== undefined && typeof record.primary !== 'boolean') {
    fail(`${path}.primary must be boolean`)
  }
  const primary = record.primary === true ? true : record.primary === false ? false : undefined
  return {
    label: expectNonEmptyString(record.label, `${path}.label`),
    url: expectHttpsUrl(record.url, `${path}.url`),
    ...(primary === undefined ? {} : { primary }),
  }
}

export const decodeWorkflowReportRecord = (value: unknown): WorkflowReportRecord => {
  const record = expectRecord(value, 'WorkflowReportRecord')
  expectExactKeys(
    record,
    [
      '_tag',
      'schemaVersion',
      'id',
      'kind',
      'subject',
      'status',
      'title',
      'summary',
      'createdAtUtc',
      'links',
      'data',
    ],
    'WorkflowReportRecord',
  )
  if (record._tag !== 'WorkflowReportRecord') {
    fail('WorkflowReportRecord._tag must be WorkflowReportRecord')
  }
  if (record.schemaVersion !== 1) fail('WorkflowReportRecord.schemaVersion must be 1')
  if (workflowReportStatuses.has(record.status as WorkflowReportStatus) === false) {
    fail('WorkflowReportRecord.status is invalid')
  }
  if (record.summary !== undefined && typeof record.summary !== 'string') {
    fail('WorkflowReportRecord.summary must be a string')
  }
  const summary = typeof record.summary === 'string' ? record.summary : undefined
  return {
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: expectNonEmptyString(record.id, 'WorkflowReportRecord.id'),
    kind: expectNonEmptyString(record.kind, 'WorkflowReportRecord.kind'),
    subject: decodeSubject(record.subject, 'WorkflowReportRecord.subject'),
    status: record.status as WorkflowReportStatus,
    title: expectNonEmptyString(record.title, 'WorkflowReportRecord.title'),
    ...(summary === undefined ? {} : { summary }),
    createdAtUtc: expectIsoUtc(record.createdAtUtc, 'WorkflowReportRecord.createdAtUtc'),
    ...(record.links === undefined
      ? {}
      : {
          links: expectArray(record.links, 'WorkflowReportRecord.links').map((link, index) =>
            decodeLink(link, `WorkflowReportRecord.links[${index}]`),
          ),
        }),
    ...(record.data === undefined
      ? {}
      : { data: expectRecord(record.data, 'WorkflowReportRecord.data') }),
  }
}

export const decodeWorkflowReportBundle = (value: unknown): WorkflowReportBundle => {
  const record = expectRecord(value, 'WorkflowReportBundle')
  expectExactKeys(
    record,
    ['_tag', 'schemaVersion', 'bundleId', 'generatedAtUtc', 'records'],
    'WorkflowReportBundle',
  )
  if (record._tag !== 'WorkflowReportBundle') {
    fail('WorkflowReportBundle._tag must be WorkflowReportBundle')
  }
  if (record.schemaVersion !== 1) fail('WorkflowReportBundle.schemaVersion must be 1')
  return {
    _tag: 'WorkflowReportBundle',
    schemaVersion: 1,
    bundleId: expectNonEmptyString(record.bundleId, 'WorkflowReportBundle.bundleId'),
    generatedAtUtc: expectIsoUtc(record.generatedAtUtc, 'WorkflowReportBundle.generatedAtUtc'),
    records: expectArray(record.records, 'WorkflowReportBundle.records').map((item, index) =>
      decodeWorkflowReportRecordWithPath(item, `WorkflowReportBundle.records[${index}]`),
    ),
  }
}

const decodeManagedEntry = (value: unknown, path: string): WorkflowReportManagedEntry => {
  const record = expectRecord(value, path)
  expectExactKeys(record, ['_tag', 'entryId', 'label', 'createdAtUtc', 'records'], path)
  if (record._tag !== 'WorkflowReportManagedEntry') {
    fail(`${path}._tag must be WorkflowReportManagedEntry`)
  }
  return {
    _tag: 'WorkflowReportManagedEntry',
    entryId: expectNonEmptyString(record.entryId, `${path}.entryId`),
    label: expectNonEmptyString(record.label, `${path}.label`),
    createdAtUtc: expectIsoUtc(record.createdAtUtc, `${path}.createdAtUtc`),
    records: expectArray(record.records, `${path}.records`).map((item, index) =>
      decodeWorkflowReportRecordWithPath(item, `${path}.records[${index}]`),
    ),
  }
}

export const decodeWorkflowReportManagedState = (value: unknown): WorkflowReportManagedState => {
  const record = expectRecord(value, 'WorkflowReportManagedState')
  expectExactKeys(
    record,
    ['_tag', 'schemaVersion', 'stateId', 'timeZone', 'recordOrder', 'entries'],
    'WorkflowReportManagedState',
  )
  if (record._tag !== 'WorkflowReportManagedState') {
    fail('WorkflowReportManagedState._tag must be WorkflowReportManagedState')
  }
  if (record.schemaVersion !== 1) fail('WorkflowReportManagedState.schemaVersion must be 1')
  return {
    _tag: 'WorkflowReportManagedState',
    schemaVersion: 1,
    stateId: expectNonEmptyString(record.stateId, 'WorkflowReportManagedState.stateId'),
    timeZone: expectNonEmptyString(record.timeZone, 'WorkflowReportManagedState.timeZone'),
    recordOrder: expectArray(record.recordOrder, 'WorkflowReportManagedState.recordOrder').map(
      (item, index) =>
        expectNonEmptyString(item, `WorkflowReportManagedState.recordOrder[${index}]`),
    ),
    entries: expectArray(record.entries, 'WorkflowReportManagedState.entries').map((item, index) =>
      decodeManagedEntry(item, `WorkflowReportManagedState.entries[${index}]`),
    ),
  }
}

const decodeWorkflowReportRecordWithPath = (value: unknown, path: string): WorkflowReportRecord => {
  try {
    return decodeWorkflowReportRecord(value)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${path}: ${message}`, { cause })
  }
}

const parseJson = (source: string, path: string): unknown => {
  try {
    return JSON.parse(source) as unknown
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${path} must be valid JSON: ${message}`, { cause })
  }
}

export const decodeWorkflowReportRecordJson = (source: string): WorkflowReportRecord =>
  decodeWorkflowReportRecord(parseJson(source, 'WorkflowReportRecordJson'))

export const decodeWorkflowReportBundleJson = (source: string): WorkflowReportBundle =>
  decodeWorkflowReportBundle(parseJson(source, 'WorkflowReportBundleJson'))

export const decodeWorkflowReportManagedStateJson = (source: string): WorkflowReportManagedState =>
  decodeWorkflowReportManagedState(parseJson(source, 'WorkflowReportManagedStateJson'))

export const encodeWorkflowReportRecordJson = (record: WorkflowReportRecord) =>
  JSON.stringify(decodeWorkflowReportRecord(record))

export const encodeWorkflowReportBundleJson = (bundle: WorkflowReportBundle) =>
  `${JSON.stringify(decodeWorkflowReportBundle(bundle), undefined, 2)}\n`

export const encodeWorkflowReportManagedStateJson = (state: WorkflowReportManagedState) =>
  `${JSON.stringify(decodeWorkflowReportManagedState(state), undefined, 2)}\n`

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

export const collectWorkflowReportBundle = (opts: {
  readonly bundleId: string
  readonly generatedAtUtc: string
  readonly sources: readonly string[]
  readonly marker?: string
}): WorkflowReportBundle =>
  createWorkflowReportBundle({
    bundleId: opts.bundleId,
    generatedAtUtc: opts.generatedAtUtc,
    records: opts.sources.flatMap(
      (source) =>
        parseMarkedWorkflowReportJsonl(
          source,
          opts.marker === undefined ? {} : { marker: opts.marker },
        ).records,
    ),
  })

const extractDelimitedJson = (
  body: string,
  opts: {
    readonly prefix: string
    readonly suffix: string
    readonly missingSuffixMessage: string
  },
): string | undefined => {
  const startIndex = body.indexOf(opts.prefix)
  if (startIndex === -1) return undefined

  const stateStartIndex = startIndex + opts.prefix.length
  const endIndex = body.indexOf(opts.suffix, stateStartIndex)
  if (endIndex === -1) {
    throw new Error(opts.missingSuffixMessage)
  }

  return body.slice(stateStartIndex, endIndex)
}

export const extractWorkflowReportManagedState = (
  body: string,
  opts: { readonly stateId?: string } = {},
): WorkflowReportManagedState | undefined => {
  const rawState = extractDelimitedJson(body, {
    prefix: workflowReportStatePrefix,
    suffix: workflowReportStateSuffix,
    missingSuffixMessage:
      'Existing workflow report comment is missing the managed state suffix marker',
  })
  if (rawState === undefined) return undefined

  const state = decodeWorkflowReportManagedStateJson(rawState)
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

export const findWorkflowReportManagedComment = (
  comments: readonly WorkflowReportManagedComment[],
  opts: {
    readonly stateId: string
    readonly marker?: string
  },
): WorkflowReportManagedCommentMatch | undefined => {
  const marker = opts.marker ?? workflowReportManagedMarker
  for (const comment of comments.toReversed()) {
    if (typeof comment.body !== 'string') continue

    if (comment.body.includes(marker) === true) {
      const state = extractWorkflowReportManagedState(comment.body)
      if (state?.stateId === opts.stateId) return { id: String(comment.id), state }
      continue
    }
  }

  return undefined
}

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

  const maxEntries = opts.stateId === 'pipeline-traces' ? 1 : (opts.maxEntries ?? 50)
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

  const recordOrder =
    opts.stateId === 'pipeline-traces'
      ? [...new Set(opts.records.map((record) => record.subject.id))]
      : [
          ...new Set([
            ...opts.records.map((record) => record.subject.id),
            ...priorState.recordOrder,
            ...priorState.entries.flatMap((entry) =>
              entry.records.map((record) => record.subject.id),
            ),
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

const renderPipelineTraces = (opts: {
  readonly record: WorkflowReportRecord
  readonly maxRows?: number | undefined
  readonly includeGantt?: boolean | undefined
}): string[] => {
  const { record } = opts
  if (record.kind !== 'pipeline-traces')
    return [escapeMarkdownTableCell(record.summary ?? 'Jobs API report unavailable')]
  const data = record.data
  if (data === undefined || Array.isArray(data.rows) === false) {
    throw new Error('Pipeline traces report rows are missing')
  }
  const rows = data.rows as readonly Record<string, unknown>[]
  const visibleRows = opts.maxRows === undefined ? rows : rows.slice(0, opts.maxRows)
  const escaped = (value: unknown): string =>
    escapeMarkdownTableCell(String(value ?? 'unavailable'))
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  const lines = [
    escaped(record.summary),
    '',
    '| Job | Status | Wall time | Delta vs main p50 | Trace |',
    '| --- | --- | --- | --- | --- |',
    ...visibleRows.map((row) => {
      const trace =
        row.status !== 'skipped' && row.status !== 'unfinished' && row.instrumented === false
          ? 'not instrumented'
          : typeof row.traceUrl === 'string' &&
              /^https?:\/\/[^\s<>)]+$/u.test(row.traceUrl) === true
            ? `[Explore](${row.traceUrl})`
            : typeof row.traceId === 'string' && /^[0-9a-f]{32}$/u.test(row.traceId) === true
              ? `\`${row.traceId}\` (link unavailable)`
              : 'unavailable'
      return `| ${escaped(row.job)} | ${escaped(row.status)} | ${escaped(row.wallTime)} | ${escaped(row.delta)} | ${trace} |`
    }),
    ...(visibleRows.length === rows.length
      ? []
      : [
          `${rows.length - visibleRows.length} additional job row(s) omitted to fit the GitHub comment limit.`,
          '',
        ]),
    '',
    `Main baseline samples (by job): ${
      Object.entries(data.baselineCounts ?? {})
        .map(([key, count]) => `${escaped(key)} n=${escaped(count)}`)
        .join(', ') || 'unavailable'
    }.`,
    `Selected main run IDs: ${Array.isArray(data.baselineRunIds) === true ? data.baselineRunIds.map(escaped).join(', ') || 'none' : 'none'}.`,
    ...(Array.isArray(data.skippedBaselineRunIds) === true && data.skippedBaselineRunIds.length > 0
      ? [
          `Skipped main run IDs (Jobs API unavailable): ${data.skippedBaselineRunIds.map(escaped).join(', ')}.`,
        ]
      : []),
    'Task-level durations are not included. Trace links may be empty while export, indexing, or retention is pending.',
  ]
  if (typeof data.gantt === 'string' && opts.includeGantt !== false) {
    lines.push(
      '',
      '<details>',
      '<summary>Pipeline timeline</summary>',
      '',
      '```mermaid',
      data.gantt,
      '```',
      '',
      '</details>',
    )
  }
  if (typeof data.gantt === 'string' && opts.includeGantt === false) {
    lines.push('', 'Pipeline timeline omitted to fit the GitHub comment limit.')
  }
  if (typeof data.omittedBars === 'number' && data.omittedBars > 0) {
    lines.push(
      '',
      `${data.omittedBars} job(s) without a start time are omitted from the timeline, not measured as zero.`,
    )
  }
  return lines
}

// The pipeline comment replaces its entry each run; keep only identity metadata in the
// hidden state, not a second copy of the table and gantt already visible in the comment.
const embeddedWorkflowReportState = (
  state: WorkflowReportManagedState,
): WorkflowReportManagedState =>
  state.stateId === 'pipeline-traces'
    ? {
        ...state,
        entries: state.entries.slice(0, 1).map((entry) =>
          Object.assign({}, entry, {
            records: entry.records.map((record) => {
              const stored = { ...record }
              delete stored.data
              return stored
            }),
          }),
        ),
      }
    : state

const renderWorkflowReportCommentBodyUnbounded = (opts: {
  readonly title: string
  readonly noRecordsMessage: string
  readonly state: WorkflowReportManagedState
  readonly includeHistory?: boolean
  readonly maxPipelineRows?: number
  readonly includePipelineGantt?: boolean
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

  const pipelineRecords = latestRecords.filter(
    (record) => record.kind === 'pipeline-traces' || record.kind === 'pipeline-traces-error',
  )
  const visibleLines =
    pipelineRecords.length > 0
      ? [
          `## ${opts.title}`,
          '',
          ...pipelineRecords.flatMap((record) =>
            renderPipelineTraces({
              record,
              maxRows: opts.maxPipelineRows,
              includeGantt: opts.includePipelineGantt,
            }),
          ),
        ]
      : latestRecords.length === 0
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
  return `${visibleLines.join('\n')}\n\n${renderWorkflowReportManagedState(embeddedWorkflowReportState(opts.state))}\n`
}

const githubCommentBodyMaxLength = 65_536
const workflowReportCommentBodyMaxLength = 60_000

export const renderWorkflowReportCommentBody = (opts: {
  readonly title: string
  readonly noRecordsMessage: string
  readonly state: WorkflowReportManagedState
  readonly includeHistory?: boolean
}) => {
  let retainedEntries = opts.state.entries

  while (retainedEntries.length > 1) {
    const body = renderWorkflowReportCommentBodyUnbounded({
      ...opts,
      state: { ...opts.state, entries: retainedEntries },
    })
    if (body.length <= workflowReportCommentBodyMaxLength) return body
    retainedEntries = retainedEntries.slice(0, -1)
  }

  const body = renderWorkflowReportCommentBodyUnbounded({
    ...opts,
    state: { ...opts.state, entries: retainedEntries },
  })
  if (
    opts.state.stateId === 'pipeline-traces' &&
    body.length > workflowReportCommentBodyMaxLength
  ) {
    const rows = retainedEntries[0]?.records.find((record) => record.kind === 'pipeline-traces')
      ?.data?.rows
    if (Array.isArray(rows) === true) {
      let low = 0
      let high = rows.length - 1
      let fitted: string | undefined
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = renderWorkflowReportCommentBodyUnbounded({
          ...opts,
          state: { ...opts.state, entries: retainedEntries },
          maxPipelineRows: middle,
        })
        if (candidate.length <= workflowReportCommentBodyMaxLength) {
          fitted = candidate
          low = middle + 1
        } else high = middle - 1
      }
      if (fitted !== undefined) return fitted
    }

    const noGantt = renderWorkflowReportCommentBodyUnbounded({
      ...opts,
      state: { ...opts.state, entries: retainedEntries },
      maxPipelineRows: 0,
      includePipelineGantt: false,
    })
    if (noGantt.length <= workflowReportCommentBodyMaxLength) return noGantt

    // Pathological provider text must still leave a managed, updateable comment.
    const emptyState: WorkflowReportManagedState = {
      ...opts.state,
      recordOrder: [],
      entries: [],
    }
    return `## Pipeline traces\n\nReport details exceeded the GitHub comment limit.\n\n${renderWorkflowReportManagedState(emptyState)}\n`
  }
  if (body.length > githubCommentBodyMaxLength) {
    throw new Error(
      `Current workflow report entry exceeds the GitHub comment limit (${body.length} > ${githubCommentBodyMaxLength} characters)`,
    )
  }

  return body
}
