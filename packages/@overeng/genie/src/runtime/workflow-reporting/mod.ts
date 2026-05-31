/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Wire-contract exports mirror JSON field names; validators use value/path pairs for precise errors. */

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

export type WorkflowReportManagedStateMigration = {
  readonly marker: string
  readonly extract: (body: string) => WorkflowReportManagedState | undefined
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

export const findWorkflowReportManagedCommentId = (
  comments: readonly WorkflowReportManagedComment[],
  opts: { readonly stateId: string; readonly marker?: string },
): string | undefined => {
  const match = findWorkflowReportManagedComment(comments, opts)
  return match?.id
}

export const findWorkflowReportManagedComment = (
  comments: readonly WorkflowReportManagedComment[],
  opts: {
    readonly stateId: string
    readonly marker?: string
    readonly migrations?: readonly WorkflowReportManagedStateMigration[]
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

    for (const migration of opts.migrations ?? []) {
      if (comment.body.includes(migration.marker) === false) continue
      const state = migration.extract(comment.body)
      if (state?.stateId === opts.stateId) return { id: String(comment.id), state }
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

const legacyDeployPreviewMarker = '<!-- deploy-preview-comment:managed -->'
const legacyDeployPreviewStatePrefix = '<!-- deploy-preview-comment:state\n'
const legacyDeployPreviewStateSuffix = '\n-->'

const legacyStateJson = (body: string) =>
  extractDelimitedJson(body, {
    prefix: legacyDeployPreviewStatePrefix,
    suffix: legacyDeployPreviewStateSuffix,
    missingSuffixMessage: 'Existing deploy-preview comment is missing the state suffix marker',
  })

const legacyRecordFromDeployTarget = (opts: {
  readonly provider: string
  readonly kind: string
  readonly entryCreatedAtUtc: string
  readonly value: unknown
  readonly path: string
}): WorkflowReportRecord => {
  const target = expectRecord(opts.value, opts.path)
  const subjectId = expectNonEmptyString(target.target, `${opts.path}.target`)
  const displayName = expectNonEmptyString(target.displayName, `${opts.path}.displayName`)
  const finalUrl = expectHttpsUrl(target.finalUrl, `${opts.path}.finalUrl`)
  const rawDeployUrl = expectHttpsUrl(target.rawDeployUrl, `${opts.path}.rawDeployUrl`)
  const deployedAtUtc =
    target.deployedAtUtc === undefined
      ? opts.entryCreatedAtUtc
      : expectIsoUtc(target.deployedAtUtc, `${opts.path}.deployedAtUtc`)

  return decodeWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: `deploy-${opts.provider}-${subjectId}`,
    kind: opts.kind,
    subject: { id: subjectId, label: displayName },
    status: 'success',
    title: `${displayName} preview deployed`,
    summary: 'Preview is ready',
    createdAtUtc: deployedAtUtc,
    links: [{ label: 'Preview', url: finalUrl, primary: true }],
    data: {
      provider: opts.provider,
      target: subjectId,
      displayName,
      rawDeployUrl,
      finalUrl,
      deployedAtUtc,
    },
  })
}

const legacyRecordFromStorybookPackage = (opts: {
  readonly value: unknown
  readonly path: string
  readonly entryCreatedAtUtc: string
}): WorkflowReportRecord => {
  const pkg = expectRecord(opts.value, opts.path)
  const packageName = expectNonEmptyString(pkg.packageName, `${opts.path}.packageName`)
  const finalUrl =
    typeof pkg.finalUrl === 'string'
      ? expectHttpsUrl(pkg.finalUrl, `${opts.path}.finalUrl`)
      : expectHttpsUrl(pkg.url, `${opts.path}.url`)
  const rawDeployUrl =
    typeof pkg.rawDeployUrl === 'string'
      ? expectHttpsUrl(pkg.rawDeployUrl, `${opts.path}.rawDeployUrl`)
      : finalUrl
  const deployedAtUtc =
    typeof pkg.deployedAtUtc === 'string'
      ? expectIsoUtc(pkg.deployedAtUtc, `${opts.path}.deployedAtUtc`)
      : opts.entryCreatedAtUtc

  return decodeWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: `deploy-netlify-${packageName}`,
    kind: 'deploy-preview',
    subject: { id: packageName, label: packageName },
    status: 'success',
    title: `${packageName} preview deployed`,
    summary: 'Preview is ready',
    createdAtUtc: deployedAtUtc,
    links: [{ label: 'Preview', url: finalUrl, primary: true }],
    data: {
      provider: 'netlify',
      target: packageName,
      displayName: packageName,
      rawDeployUrl,
      finalUrl,
      deployedAtUtc,
    },
  })
}

export const legacyDeployPreviewManagedStateMigration = {
  marker: legacyDeployPreviewMarker,
  extract: (body: string): WorkflowReportManagedState | undefined => {
    const rawState = legacyStateJson(body)
    if (rawState === undefined) return undefined

    const legacyState = expectRecord(
      parseJson(rawState, 'LegacyDeployPreviewState'),
      'LegacyDeployPreviewState',
    )
    if (legacyState._tag !== 'deploy-preview-comment-state') return undefined

    const timeZone = expectNonEmptyString(legacyState.timeZone, 'LegacyDeployPreviewState.timeZone')
    const targetOrder = expectArray(
      legacyState.targetOrder,
      'LegacyDeployPreviewState.targetOrder',
    ).map((target, index) =>
      expectNonEmptyString(target, `LegacyDeployPreviewState.targetOrder[${index}]`),
    )
    const entries = expectArray(legacyState.commits, 'LegacyDeployPreviewState.commits').map(
      (commit, commitIndex) => {
        const entry = expectRecord(commit, `LegacyDeployPreviewState.commits[${commitIndex}]`)
        const entryId = expectNonEmptyString(
          entry.commitSha,
          `LegacyDeployPreviewState.commits[${commitIndex}].commitSha`,
        )
        const label = expectNonEmptyString(
          entry.modeLabel,
          `LegacyDeployPreviewState.commits[${commitIndex}].modeLabel`,
        )
        const records = expectArray(
          entry.targets,
          `LegacyDeployPreviewState.commits[${commitIndex}].targets`,
        ).map((target, targetIndex) =>
          legacyRecordFromDeployTarget({
            provider: 'vercel',
            kind: 'deploy-preview',
            entryCreatedAtUtc: new Date(0).toISOString(),
            value: target,
            path: `LegacyDeployPreviewState.commits[${commitIndex}].targets[${targetIndex}]`,
          }),
        )
        const createdAtUtc =
          records
            .map((record) => record.createdAtUtc)
            .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0] ??
          new Date(0).toISOString()

        return {
          _tag: 'WorkflowReportManagedEntry' as const,
          entryId,
          label,
          createdAtUtc,
          records,
        }
      },
    )

    return decodeWorkflowReportManagedState({
      _tag: 'WorkflowReportManagedState',
      schemaVersion: 1,
      stateId: 'deploy-preview',
      timeZone,
      recordOrder: targetOrder,
      entries,
    })
  },
} satisfies WorkflowReportManagedStateMigration

export const legacyStorybookPreviewManagedStateMigration = {
  marker: legacyDeployPreviewMarker,
  extract: (body: string): WorkflowReportManagedState | undefined => {
    const rawState = legacyStateJson(body)
    if (rawState === undefined) return undefined

    const legacyState = expectRecord(
      parseJson(rawState, 'LegacyStorybookPreviewState'),
      'LegacyStorybookPreviewState',
    )
    if (legacyState._tag !== 'storybook-preview-comment-state') return undefined

    const timeZone = expectNonEmptyString(
      legacyState.timeZone,
      'LegacyStorybookPreviewState.timeZone',
    )
    const packageOrder = expectArray(
      legacyState.packageOrder,
      'LegacyStorybookPreviewState.packageOrder',
    ).map((pkg, index) =>
      expectNonEmptyString(pkg, `LegacyStorybookPreviewState.packageOrder[${index}]`),
    )
    const entries = expectArray(legacyState.commits, 'LegacyStorybookPreviewState.commits').map(
      (commit, commitIndex) => {
        const entry = expectRecord(commit, `LegacyStorybookPreviewState.commits[${commitIndex}]`)
        const entryId = expectNonEmptyString(
          entry.commitSha,
          `LegacyStorybookPreviewState.commits[${commitIndex}].commitSha`,
        )
        const label = expectNonEmptyString(
          entry.modeLabel,
          `LegacyStorybookPreviewState.commits[${commitIndex}].modeLabel`,
        )
        const entryCreatedAtUtc = expectIsoUtc(
          entry.deployedAtUtc,
          `LegacyStorybookPreviewState.commits[${commitIndex}].deployedAtUtc`,
        )
        const records = expectArray(
          entry.packages,
          `LegacyStorybookPreviewState.commits[${commitIndex}].packages`,
        ).map((pkg, packageIndex) =>
          legacyRecordFromStorybookPackage({
            value: pkg,
            path: `LegacyStorybookPreviewState.commits[${commitIndex}].packages[${packageIndex}]`,
            entryCreatedAtUtc,
          }),
        )

        return {
          _tag: 'WorkflowReportManagedEntry' as const,
          entryId,
          label,
          createdAtUtc: entryCreatedAtUtc,
          records,
        }
      },
    )

    return decodeWorkflowReportManagedState({
      _tag: 'WorkflowReportManagedState',
      schemaVersion: 1,
      stateId: 'storybook-preview',
      timeZone,
      recordOrder: packageOrder,
      entries,
    })
  },
} satisfies WorkflowReportManagedStateMigration

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
