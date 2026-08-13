/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args, overeng/explicit-boolean-compare -- Dense receipt validation uses value/path pairs and schema declarations as its public documentation. */
/* oxlint-disable unicorn/no-array-sort -- Receipt normalization deliberately targets ES2022; Array.prototype.toSorted requires ES2023. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

export type Sha256Digest = `sha256:${string}`
export type ActionOutcome =
  | 'dice_reuse'
  | 'local_cache_hit'
  | 'local_cache_miss'
  | 'remote_cache_hit'
  | 'remote_cache_miss'
  | 'local_execution'
  | 'remote_execution'
  | 'materialized_only'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export interface EvidenceDescriptor {
  readonly digest: Sha256Digest
  readonly byteLength: number
  readonly mediaType: string
}

export interface BuckRunReceipt {
  readonly schema: 'buck-run-receipt/v1'
  readonly launcherRunId: string
  readonly buckInvocationId?: string
  /** Added during v1; absent only on receipts written by older launchers. */
  readonly repositoryRevision?: string
  /** Added during v1; absent only on receipts written by older launchers. */
  readonly executionPlatform?: string
  readonly command: { readonly kind: string; readonly requestedTargets: ReadonlyArray<string> }
  readonly status: {
    readonly exitCode: number
    readonly success: boolean
    readonly errorCategory?: string
  }
  readonly timing: {
    readonly startedAt: string
    readonly endedAt: string
    readonly durationMs: number
  }
  readonly buck: { readonly machineVersion?: string }
  readonly evidence: {
    readonly eventLog?: EvidenceDescriptor
    readonly buildReport?: EvidenceDescriptor
  }
  readonly observation: {
    readonly complete: boolean
    readonly verdict: 'complete' | 'incomplete'
    readonly reasons: ReadonlyArray<string>
    readonly whatRan: LogQueryObservation
    readonly materialized: LogQueryObservation
  }
  readonly outputs: ReadonlyArray<{ readonly target: string; readonly buckDigest: string }>
  readonly closures: ReadonlyArray<{
    readonly label: string
    readonly descriptor: EvidenceDescriptor
  }>
  readonly actions: ReadonlyArray<NormalizedAction>
  readonly outcomes: Partial<Record<ActionOutcome, number>>
  readonly materialization: {
    readonly records: number
    readonly files: number
    readonly bytes: number
  }
  readonly explanation: {
    readonly status: 'exact' | 'partial' | 'unknown'
    readonly changedDimensions: ReadonlyArray<{
      readonly dimension: 'externalClosure'
      readonly label: string
      readonly beforeDigest?: Sha256Digest
      readonly afterDigest?: Sha256Digest
    }>
    readonly note: string
  }
}

/** Dependency-free JSON Schema surface; the generated package can project this into Effect Schema later. */
export const BuckRunReceiptJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://overeng.dev/schemas/buck-run-receipt.v1.json',
  type: 'object',
  required: [
    'schema',
    'launcherRunId',
    'command',
    'status',
    'timing',
    'buck',
    'evidence',
    'observation',
    'outputs',
    'closures',
    'actions',
    'outcomes',
    'materialization',
    'explanation',
  ],
  properties: {
    schema: { const: 'buck-run-receipt/v1' },
    launcherRunId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
    buckInvocationId: { type: 'string', minLength: 1 },
    repositoryRevision: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' },
    executionPlatform: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$',
    },
    command: {
      type: 'object',
      required: ['kind', 'requestedTargets'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', minLength: 1 },
        requestedTargets: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    status: {
      type: 'object',
      required: ['exitCode', 'success'],
      additionalProperties: false,
      properties: {
        exitCode: { type: 'integer' },
        success: { type: 'boolean' },
        errorCategory: { type: 'string', minLength: 1 },
      },
    },
    timing: {
      type: 'object',
      required: ['startedAt', 'endedAt', 'durationMs'],
      additionalProperties: false,
      properties: {
        startedAt: { type: 'string', minLength: 1 },
        endedAt: { type: 'string', minLength: 1 },
        durationMs: { type: 'number', minimum: 0 },
      },
    },
    buck: {
      type: 'object',
      additionalProperties: false,
      properties: { machineVersion: { type: 'string', minLength: 1 } },
    },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        eventLog: { $ref: '#/$defs/descriptor' },
        buildReport: { $ref: '#/$defs/descriptor' },
      },
    },
    observation: {
      type: 'object',
      required: ['complete', 'verdict', 'reasons', 'whatRan', 'materialized'],
      additionalProperties: false,
      properties: {
        complete: { type: 'boolean' },
        verdict: { enum: ['complete', 'incomplete'] },
        reasons: { type: 'array', items: { type: 'string', minLength: 1 } },
        whatRan: { $ref: '#/$defs/logObservation' },
        materialized: { $ref: '#/$defs/logObservation' },
      },
    },
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['target', 'buckDigest'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', minLength: 1 },
          buckDigest: { type: 'string', minLength: 1 },
        },
      },
    },
    closures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'descriptor'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', minLength: 1 },
          descriptor: { $ref: '#/$defs/descriptor' },
        },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['identity', 'outcome'],
        additionalProperties: false,
        properties: {
          identity: { type: 'string', minLength: 1 },
          outcome: { $ref: '#/$defs/outcome' },
          executor: { type: 'string', minLength: 1 },
          durationMs: { type: 'number', minimum: 0 },
        },
      },
    },
    outcomes: {
      type: 'object',
      propertyNames: { $ref: '#/$defs/outcome' },
      additionalProperties: { type: 'integer', minimum: 0 },
    },
    materialization: {
      type: 'object',
      required: ['records', 'files', 'bytes'],
      additionalProperties: false,
      properties: {
        records: { type: 'integer', minimum: 0 },
        files: { type: 'integer', minimum: 0 },
        bytes: { type: 'integer', minimum: 0 },
      },
    },
    explanation: {
      type: 'object',
      required: ['status', 'changedDimensions', 'note'],
      additionalProperties: false,
      properties: {
        status: { enum: ['exact', 'partial', 'unknown'] },
        note: { type: 'string', minLength: 1 },
        changedDimensions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['dimension', 'label'],
            additionalProperties: false,
            properties: {
              dimension: { const: 'externalClosure' },
              label: { type: 'string', minLength: 1 },
              beforeDigest: { $ref: '#/$defs/digest' },
              afterDigest: { $ref: '#/$defs/digest' },
            },
          },
        },
      },
    },
  },
  dependentRequired: {
    repositoryRevision: ['executionPlatform'],
    executionPlatform: ['repositoryRevision'],
  },
  $defs: {
    digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    descriptor: {
      type: 'object',
      required: ['digest', 'byteLength', 'mediaType'],
      additionalProperties: false,
      properties: {
        digest: { $ref: '#/$defs/digest' },
        byteLength: { type: 'integer', minimum: 0 },
        mediaType: { type: 'string', minLength: 1 },
      },
    },
    outcome: {
      enum: [
        'dice_reuse',
        'local_cache_hit',
        'local_cache_miss',
        'remote_cache_hit',
        'remote_cache_miss',
        'local_execution',
        'remote_execution',
        'materialized_only',
        'failed',
        'cancelled',
        'unknown',
      ],
    },
    logObservation: {
      type: 'object',
      required: ['exitCode', 'parseComplete', 'semanticComplete', 'records'],
      additionalProperties: false,
      properties: {
        exitCode: { type: 'integer' },
        parseComplete: { type: 'boolean' },
        semanticComplete: { type: 'boolean' },
        records: { type: 'integer', minimum: 0 },
      },
    },
  },
  additionalProperties: false,
} as const

export const decodeReceipt = (value: unknown): BuckRunReceipt => {
  const root = receiptObject(value, '$')
  if (root.schema !== 'buck-run-receipt/v1') throw new Error('unsupported receipt schema')
  const launcherRunId = receiptString(root.launcherRunId, '$.launcherRunId')
  if (isSafePathComponent(launcherRunId) === false) {
    throw new Error('receipt $.launcherRunId must be a safe path component')
  }
  if (root.buckInvocationId !== undefined)
    receiptString(root.buckInvocationId, '$.buckInvocationId')
  const hasRepositoryRevision = root.repositoryRevision !== undefined
  const hasExecutionPlatform = root.executionPlatform !== undefined
  if (hasRepositoryRevision !== hasExecutionPlatform) {
    throw new Error('receipt v1 identity fields must either both be present or both be absent')
  }
  if (hasRepositoryRevision) {
    const repositoryRevision = receiptString(root.repositoryRevision, '$.repositoryRevision')
    if (isRepositoryRevision(repositoryRevision) === false) {
      throw new Error('receipt $.repositoryRevision must be an exact Git revision')
    }
    const executionPlatform = receiptString(root.executionPlatform, '$.executionPlatform')
    if (isExecutionPlatform(executionPlatform) === false) {
      throw new Error('receipt $.executionPlatform must be a portable platform identifier')
    }
  }
  const command = receiptObject(root.command, '$.command')
  receiptString(command.kind, '$.command.kind')
  receiptStringArray(command.requestedTargets, '$.command.requestedTargets')
  const status = receiptObject(root.status, '$.status')
  receiptInteger(status.exitCode, '$.status.exitCode')
  receiptBoolean(status.success, '$.status.success')
  if (status.errorCategory !== undefined)
    receiptString(status.errorCategory, '$.status.errorCategory')
  const timing = receiptObject(root.timing, '$.timing')
  receiptString(timing.startedAt, '$.timing.startedAt')
  receiptString(timing.endedAt, '$.timing.endedAt')
  receiptNonNegative(timing.durationMs, '$.timing.durationMs')
  const buck = receiptObject(root.buck, '$.buck')
  if (buck.machineVersion !== undefined) receiptString(buck.machineVersion, '$.buck.machineVersion')
  const evidence = receiptObject(root.evidence, '$.evidence')
  if (evidence.eventLog !== undefined) receiptDescriptor(evidence.eventLog, '$.evidence.eventLog')
  if (evidence.buildReport !== undefined)
    receiptDescriptor(evidence.buildReport, '$.evidence.buildReport')
  const observation = receiptObject(root.observation, '$.observation')
  receiptBoolean(observation.complete, '$.observation.complete')
  if (observation.verdict !== 'complete' && observation.verdict !== 'incomplete') {
    throw new Error('receipt $.observation.verdict is invalid')
  }
  if (observation.complete !== (observation.verdict === 'complete')) {
    throw new Error('receipt $.observation completeness fields disagree')
  }
  receiptStringArray(observation.reasons, '$.observation.reasons')
  receiptLogObservation(observation.whatRan, '$.observation.whatRan')
  receiptLogObservation(observation.materialized, '$.observation.materialized')
  if (observation.complete === true) {
    if (evidence.eventLog === undefined || evidence.buildReport === undefined) {
      throw new Error('receipt complete observation requires event-log and build-report evidence')
    }
    for (const name of ['whatRan', 'materialized'] as const) {
      const query = receiptObject(observation[name], `$.observation.${name}`)
      if (query.exitCode !== 0 || query.parseComplete !== true || query.semanticComplete !== true) {
        throw new Error(`receipt complete observation has incomplete ${name} query`)
      }
    }
  } else if ((observation.reasons as ReadonlyArray<unknown>).length === 0) {
    throw new Error('receipt incomplete observation requires reasons')
  }
  const outputs = receiptArray(root.outputs, '$.outputs')
  for (const [index, output] of outputs.entries()) {
    const record = receiptObject(output, `$.outputs[${index}]`)
    receiptString(record.target, `$.outputs[${index}].target`)
    receiptString(record.buckDigest, `$.outputs[${index}].buckDigest`)
  }
  const closures = receiptArray(root.closures, '$.closures')
  for (const [index, closure] of closures.entries()) {
    const record = receiptObject(closure, `$.closures[${index}]`)
    receiptString(record.label, `$.closures[${index}].label`)
    receiptDescriptor(record.descriptor, `$.closures[${index}].descriptor`)
  }
  const actions = receiptArray(root.actions, '$.actions')
  for (const [index, action] of actions.entries()) {
    const record = receiptObject(action, `$.actions[${index}]`)
    receiptString(record.identity, `$.actions[${index}].identity`)
    if (!actionOutcomes.has(record.outcome as ActionOutcome)) {
      throw new Error(`receipt $.actions[${index}].outcome is invalid`)
    }
    if (record.executor !== undefined)
      receiptString(record.executor, `$.actions[${index}].executor`)
    if (record.durationMs !== undefined)
      receiptNonNegative(record.durationMs, `$.actions[${index}].durationMs`)
  }
  const outcomes = receiptObject(root.outcomes, '$.outcomes')
  for (const [outcome, count] of Object.entries(outcomes)) {
    if (!actionOutcomes.has(outcome as ActionOutcome))
      throw new Error(`receipt $.outcomes.${outcome} is invalid`)
    receiptInteger(count, `$.outcomes.${outcome}`, true)
  }
  const materialization = receiptObject(root.materialization, '$.materialization')
  receiptInteger(materialization.records, '$.materialization.records', true)
  receiptInteger(materialization.files, '$.materialization.files', true)
  receiptInteger(materialization.bytes, '$.materialization.bytes', true)
  const explanation = receiptObject(root.explanation, '$.explanation')
  if (!['exact', 'partial', 'unknown'].includes(String(explanation.status))) {
    throw new Error('receipt $.explanation.status is invalid')
  }
  receiptString(explanation.note, '$.explanation.note')
  const dimensions = receiptArray(explanation.changedDimensions, '$.explanation.changedDimensions')
  for (const [index, dimension] of dimensions.entries()) {
    const record = receiptObject(dimension, `$.explanation.changedDimensions[${index}]`)
    if (record.dimension !== 'externalClosure')
      throw new Error('receipt changed dimension is invalid')
    receiptString(record.label, `$.explanation.changedDimensions[${index}].label`)
    if (record.beforeDigest !== undefined) receiptDigest(record.beforeDigest, 'beforeDigest')
    if (record.afterDigest !== undefined) receiptDigest(record.afterDigest, 'afterDigest')
  }
  return root as unknown as BuckRunReceipt
}

const actionOutcomes = new Set<ActionOutcome>([
  'dice_reuse',
  'local_cache_hit',
  'local_cache_miss',
  'remote_cache_hit',
  'remote_cache_miss',
  'local_execution',
  'remote_execution',
  'materialized_only',
  'failed',
  'cancelled',
  'unknown',
])

export const isSafePathComponent = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
export const isRepositoryRevision = (value: string): boolean =>
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
export const isExecutionPlatform = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)
const receiptObject = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`receipt ${path} must be an object`)
  return value as Record<string, unknown>
}
const receiptArray = (value: unknown, path: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(`receipt ${path} must be an array`)
  return value
}
const receiptString = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`receipt ${path} must be a non-empty string`)
  return value
}
const receiptStringArray = (value: unknown, path: string): ReadonlyArray<string> => {
  const values = receiptArray(value, path)
  for (const [index, item] of values.entries()) receiptString(item, `${path}[${index}]`)
  return values as ReadonlyArray<string>
}
const receiptBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`receipt ${path} must be boolean`)
  return value
}
const receiptNonNegative = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`receipt ${path} must be non-negative`)
  return value
}
const receiptInteger = (value: unknown, path: string, nonNegative = false): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || (nonNegative && value < 0)) {
    throw new Error(
      `receipt ${path} must be ${nonNegative ? 'a non-negative integer' : 'an integer'}`,
    )
  }
  return value
}
const receiptDigest = (value: unknown, path: string): Sha256Digest => {
  const digest = receiptString(value, path)
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error(`receipt ${path} must be sha256`)
  return digest as Sha256Digest
}
const receiptDescriptor = (value: unknown, path: string): EvidenceDescriptor => {
  const descriptor = receiptObject(value, path)
  receiptDigest(descriptor.digest, `${path}.digest`)
  receiptInteger(descriptor.byteLength, `${path}.byteLength`, true)
  receiptString(descriptor.mediaType, `${path}.mediaType`)
  return descriptor as unknown as EvidenceDescriptor
}
const receiptLogObservation = (value: unknown, path: string): LogQueryObservation => {
  const observation = receiptObject(value, path)
  receiptInteger(observation.exitCode, `${path}.exitCode`)
  receiptBoolean(observation.parseComplete, `${path}.parseComplete`)
  receiptBoolean(observation.semanticComplete, `${path}.semanticComplete`)
  receiptInteger(observation.records, `${path}.records`, true)
  return observation as unknown as LogQueryObservation
}

export const descriptorForFile = async (
  path: string,
  mediaType: string,
): Promise<EvidenceDescriptor | undefined> => {
  try {
    const metadata = await stat(path)
    const digest = createHash('sha256')
    let observedBytes = 0
    for await (const chunk of createReadStream(path)) {
      digest.update(chunk)
      observedBytes += chunk.byteLength
    }
    if (observedBytes !== metadata.size)
      throw new Error(`evidence file changed while it was being described: ${path}`)
    return {
      digest: `sha256:${digest.digest('hex')}`,
      byteLength: metadata.size,
      mediaType,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    throw error
  }
}

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | ReadonlyArray<CanonicalJson>
  | {
      readonly [key: string]: CanonicalJson
    }

const canonicalJson = (value: unknown, path = '$'): CanonicalJson => {
  if (Array.isArray(value))
    return value.map((child, index) => canonicalJson(child, `${path}[${index}]`))
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`closure manifest ${path} is not JSON-compatible`)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalJson(child, `${path}.${key}`)]),
  )
}

const objectAt = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`closure manifest ${path} must be an object`)
  }
  return value as Record<string, unknown>
}

const stringAt = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`closure manifest ${path} must be a non-empty string`)
  }
  return value
}

const stringArrayAt = (value: unknown, path: string): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`closure manifest ${path} must be a string array`)
  }
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) {
      throw new Error(`closure manifest ${path} must be sorted and unique`)
    }
  }
  return value
}

/** Validate the generated closure projection and hash canonical JSON, never raw formatting bytes. */
export const descriptorForClosureManifest = async (
  path: string,
  expectedLabel: string,
): Promise<EvidenceDescriptor> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`closure manifest ${expectedLabel} is not valid JSON`, { cause: error })
  }
  const root = objectAt(parsed, '$')
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error('closure manifest $.schemaVersion must be 1, 2, or 3')
  }
  stringAt(root.packagePath, '$.packagePath')
  const target = objectAt(root.target, '$.target')
  stringAt(target.name, '$.target.name')
  stringAt(target.kind, '$.target.kind')
  stringAt(target.closureDescriptor, '$.target.closureDescriptor')
  stringArrayAt(target.sources, '$.target.sources')
  stringArrayAt(target.configs, '$.target.configs')
  stringArrayAt(target.deps, '$.target.deps')
  const closure = objectAt(root.closure, '$.closure')
  const labelOwner =
    root.schemaVersion === 1
      ? objectAt(closure.task, '$.closure.task')
      : objectAt(closure.request, '$.closure.request')
  const labelPath = root.schemaVersion === 1 ? '$.closure.task.label' : '$.closure.request.label'
  const actualLabel = stringAt(labelOwner.label, labelPath)
  if (actualLabel !== expectedLabel) {
    throw new Error(
      `closure manifest label mismatch: expected ${expectedLabel}, received ${actualLabel}`,
    )
  }
  const provenance = objectAt(root.provenance, '$.provenance')
  if (provenance.generator !== 'effect-utils/genie/buck2') {
    throw new Error('closure manifest $.provenance.generator is unsupported')
  }
  const declaredFingerprint = stringAt(
    provenance.semanticFingerprint,
    '$.provenance.semanticFingerprint',
  )
  if (!/^sha256:[a-f0-9]{64}$/u.test(declaredFingerprint)) {
    throw new Error('closure manifest $.provenance.semanticFingerprint must be sha256')
  }
  stringAt(provenance.regenerationCommand, '$.provenance.regenerationCommand')
  stringArrayAt(provenance.semanticInputs, '$.provenance.semanticInputs')
  if (root.schemaVersion === 3) {
    stringAt(provenance.source, '$.provenance.source')
    if (provenance.warning !== 'GENERATED FILE - DO NOT EDIT') {
      throw new Error('closure manifest $.provenance.warning must be GENERATED FILE - DO NOT EDIT')
    }
  }
  const semanticData = {
    closure: root.closure,
    packagePath: root.packagePath,
    target: root.target,
  }
  const fingerprintData =
    root.schemaVersion === 3
      ? {
          generator: provenance.generator,
          schemaVersion: root.schemaVersion,
          semanticData,
        }
      : semanticData
  const semanticBytes = Buffer.from(JSON.stringify(canonicalJson(fingerprintData)), 'utf8')
  const actualFingerprint = `sha256:${createHash('sha256').update(semanticBytes).digest('hex')}`
  if (declaredFingerprint !== actualFingerprint) {
    throw new Error('closure manifest semantic fingerprint does not match canonical semantic data')
  }
  const bytes = Buffer.from(JSON.stringify(canonicalJson(root)), 'utf8')
  return {
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteLength: bytes.byteLength,
    mediaType: 'application/json',
  }
}

const sensitiveKeyWords = new Set([
  'auth',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'key',
  'password',
  'passphrase',
  'passwd',
  'secret',
  'token',
])
const keyWords = (key: string): ReadonlyArray<string> =>
  key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0)
const isSensitiveKey = (key: string): boolean =>
  keyWords(key).some((word) => sensitiveKeyWords.has(word))

const redactJsonCredentialValues = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactJsonCredentialValues)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveKey(key) ? '<redacted>' : redactJsonCredentialValues(nested),
    ]),
  )
}

const structurallyRedactJson = (source: string): string => {
  try {
    const parsed: unknown = JSON.parse(source)
    return typeof parsed === 'object' && parsed !== null
      ? JSON.stringify(redactJsonCredentialValues(parsed))
      : source
  } catch {
    return source
  }
}

const secretAssignmentOrHeader =
  /(^|[^A-Za-z0-9])(["']?)([A-Za-z][A-Za-z0-9_-]*)(\2)(\s*[:=]\s*)(?:(?:bearer|basic)\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&]+)/gim
const secretCliArgument =
  /(^|[\s"'])--([A-Za-z][A-Za-z0-9_-]*)\s+(?:(?:bearer|basic)\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/gim
const unixAbsolutePath = /(^|[\s"'=])(\/(?!\/)[^\s"']+)/g
const windowsAbsolutePath = /\b[A-Za-z]:\\[^\s"']+/g
const urlUserInfo = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const urlQueryValue = /([?&])([A-Za-z][A-Za-z0-9_-]*)=([^\s&#]*)/gi

/** Receipt-safe text. Raw argv, command, environment, and reproducer fields are never copied. */
export const sanitizeEvidenceText = (value: unknown): string => {
  const source = structurallyRedactJson(typeof value === 'string' ? value : 'unknown')
  const sanitized = source
    .replace(urlQueryValue, (match, separator, key) =>
      isSensitiveKey(key) ? `${separator}${key}=<redacted>` : match,
    )
    .replace(secretAssignmentOrHeader, (match, prefix, _quote, key) =>
      isSensitiveKey(key) ? `${prefix}<redacted>` : match,
    )
    .replace(secretCliArgument, (match, prefix, key) =>
      isSensitiveKey(key) ? `${prefix}<redacted>` : match,
    )
    .replace(urlUserInfo, '$1<redacted>@')
    .replace(windowsAbsolutePath, '<path>')
    .replace(unixAbsolutePath, '$1<path>')
    .trim()
  return (sanitized.length === 0 ? 'unknown' : sanitized).slice(0, 512)
}

const numberAt = (value: unknown, keys: ReadonlyArray<string>): number | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0)
      return candidate
  }
  return undefined
}

const outcomeForRow = (row: Record<string, unknown>): ActionOutcome => {
  const result = String(row.outcome ?? row.cache_result ?? row.result ?? '').toLowerCase()
  const reproducer =
    typeof row.reproducer === 'object' && row.reproducer !== null
      ? (row.reproducer as Record<string, unknown>)
      : {}
  const executor = String(row.executor ?? reproducer.executor ?? '').toLowerCase()
  if (result.includes('cancel')) return 'cancelled'
  if (result.includes('fail')) return 'failed'
  if (result.includes('local') && result.includes('hit')) return 'local_cache_hit'
  if (result.includes('local') && result.includes('miss')) return 'local_cache_miss'
  if (result.includes('hit')) return 'remote_cache_hit'
  if (result.includes('miss')) return 'remote_cache_miss'
  if (executor === 're' || executor.includes('remote')) return 'remote_execution'
  if (executor.includes('local')) return 'local_execution'
  return 'unknown'
}

export interface NormalizedAction {
  readonly identity: string
  readonly outcome: ActionOutcome
  readonly executor?: string
  readonly durationMs?: number
}

export interface JsonLinesParse {
  readonly rows: ReadonlyArray<Record<string, unknown>>
  readonly complete: boolean
  readonly invalidLines: number
}

export interface LogQueryObservation {
  readonly exitCode: number
  readonly parseComplete: boolean
  readonly semanticComplete: boolean
  readonly records: number
}

export const parseJsonLinesComplete = (text: string): JsonLinesParse => {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const rows: Array<Record<string, unknown>> = []
  let invalidLines = 0
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        rows.push(value as Record<string, unknown>)
      } else invalidLines += 1
    } catch {
      invalidLines += 1
    }
  }
  return { rows, complete: invalidLines === 0, invalidLines }
}

export const parseJsonLines = (text: string): ReadonlyArray<Record<string, unknown>> =>
  parseJsonLinesComplete(text).rows

export const actionsSemanticallyComplete = (
  rows: ReadonlyArray<Record<string, unknown>>,
  actions: ReadonlyArray<NormalizedAction>,
): boolean =>
  rows.length === actions.length &&
  actions.every((action) => action.identity !== 'unknown' && action.outcome !== 'unknown')

export const materializationsSemanticallyComplete = (
  rows: ReadonlyArray<Record<string, unknown>>,
): boolean =>
  rows.every(
    (row) =>
      typeof row.path === 'string' &&
      typeof row.method === 'string' &&
      numberAt(row, ['file_count']) !== undefined &&
      numberAt(row, ['total_bytes']) !== undefined,
  )

export const normalizeActions = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<NormalizedAction> =>
  rows.map((row) => {
    const reproducer =
      typeof row.reproducer === 'object' && row.reproducer !== null
        ? (row.reproducer as Record<string, unknown>)
        : {}
    const executorValue = row.executor ?? reproducer.executor
    const executor =
      typeof executorValue === 'string' ? sanitizeEvidenceText(executorValue) : undefined
    const duration = row.duration_ms ?? row.durationMs ?? row.duration
    const durationMs = (() => {
      if (typeof duration === 'number' && duration >= 0) return duration
      if (typeof duration !== 'string') return undefined
      const match = /^(\d+(?:\.\d+)?)(ms|s|us|µs)$/u.exec(duration.trim())
      if (match === null) return undefined
      const amount = Number(match[1])
      return match[2] === 's' ? amount * 1_000 : match[2] === 'ms' ? amount : amount / 1_000
    })()
    return {
      identity: sanitizeEvidenceText(row.identity ?? row.action ?? 'unknown'),
      outcome: outcomeForRow(row),
      ...(executor === undefined ? {} : { executor }),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
  })

export const normalizeMaterialization = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  records: rows.length,
  files: Math.trunc(
    rows.reduce((sum, row) => sum + (numberAt(row, ['file_count', 'files']) ?? 0), 0),
  ),
  bytes: Math.trunc(
    rows.reduce(
      (sum, row) => sum + (numberAt(row, ['total_bytes', 'bytes', 'size_bytes']) ?? 0),
      0,
    ),
  ),
})

export const countOutcomes = (
  actions: ReadonlyArray<NormalizedAction>,
  fallback?: ActionOutcome,
): Partial<Record<ActionOutcome, number>> => {
  const counts: Partial<Record<ActionOutcome, number>> = {}
  for (const action of actions) counts[action.outcome] = (counts[action.outcome] ?? 0) + 1
  if (actions.length === 0 && fallback !== undefined) counts[fallback] = 1
  return counts
}

export interface ClosureDigest {
  readonly label: string
  readonly descriptor: EvidenceDescriptor
}

export const explainClosures = (
  current: ReadonlyArray<ClosureDigest>,
  previous: ReadonlyArray<ClosureDigest> | undefined,
  actionCount: number,
  observationComplete = true,
): BuckRunReceipt['explanation'] => {
  if (!observationComplete) {
    return {
      status: 'unknown',
      changedDimensions: [],
      note: 'Buck log observation was incomplete; invalidation explanation has no verdict.',
    }
  }
  if (previous === undefined) {
    return {
      status: actionCount === 0 ? 'partial' : 'unknown',
      changedDimensions: [],
      note:
        actionCount === 0
          ? 'No action was observed; no previous closure receipt was supplied.'
          : 'Buck observed work, but no previous closure receipt was supplied.',
    }
  }
  const before = new Map(previous.map((entry) => [entry.label, entry.descriptor.digest]))
  const after = new Map(current.map((entry) => [entry.label, entry.descriptor.digest]))
  const labels = [...new Set([...before.keys(), ...after.keys()])].sort()
  const changedDimensions = labels.flatMap((label) => {
    const beforeDigest = before.get(label)
    const afterDigest = after.get(label)
    if (beforeDigest === afterDigest) return []
    return [
      {
        dimension: 'externalClosure' as const,
        label: sanitizeEvidenceText(label),
        ...(beforeDigest === undefined ? {} : { beforeDigest }),
        ...(afterDigest === undefined ? {} : { afterDigest }),
      },
    ]
  })
  if (changedDimensions.length > 0) {
    return {
      status: 'exact',
      changedDimensions,
      note: 'Canonical closure manifest digests identify the changed external dependency dimension.',
    }
  }
  const hasClosureEvidence = current.length > 0 || previous.length > 0
  return {
    status: actionCount === 0 && hasClosureEvidence ? 'exact' : 'partial',
    changedDimensions: [],
    note:
      actionCount === 0 && hasClosureEvidence
        ? 'Canonical closure manifest digests are unchanged and Buck observed no action.'
        : actionCount === 0
          ? 'Buck observed no action, but no closure manifest was available for comparison.'
          : 'Canonical closure manifest digests are unchanged; another input dimension caused work.',
  }
}
