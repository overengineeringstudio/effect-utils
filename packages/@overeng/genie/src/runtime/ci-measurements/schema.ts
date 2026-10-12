import { Schema } from 'effect'
import { renderJsonSchemaValidator } from '../json-schema-validation/mod.ts'

/** Numeric versions are wire contracts, shared by producers and generated decoders. */
export const ciMeasurementSchemaVersion = 1
export const ciMeasurementCommentStateTag = 'ci-measurement-comment-state'

const optionalStrings = <const TNames extends readonly string[]>(names: TNames) =>
  Object.fromEntries(names.map((name) => [name, Schema.optional(Schema.String)])) as {
    [TName in TNames[number]]: Schema.optional<typeof Schema.String>
  }
const optionalNumbers = <const TNames extends readonly string[]>(names: TNames) =>
  Object.fromEntries(names.map((name) => [name, Schema.optional(Schema.NullOr(Schema.Finite))])) as {
    [TName in TNames[number]]: Schema.optional<Schema.NullOr<typeof Schema.Finite>>
  }
const optionalFiniteNumbers = <const TNames extends readonly string[]>(names: TNames) =>
  Object.fromEntries(names.map((name) => [name, Schema.optional(Schema.Finite)])) as {
    [TName in TNames[number]]: Schema.optional<typeof Schema.Finite>
  }

export const CiMeasurementGatePolicy = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  comparisonMode: Schema.optional(Schema.Literals(['budget', 'historical', 'paired', 'diagnostic'])),
  gate: Schema.optional(Schema.Literal('off')),
  ...optionalFiniteNumbers(['minBaselineSources', 'minCurrentSamples', 'minPairedSamples', 'noiseFloor',
    'statisticalToleranceRatio', 'statisticalToleranceAbs', 'pairedEvidenceQuantile',
    'warnRatio', 'failRatio', 'warnAbs', 'failAbs']),
})
export type CiMeasurementGatePolicy = typeof CiMeasurementGatePolicy.Type
export const CiMeasurementTarget = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  ...optionalStrings(['name', 'label', 'group', 'system']),
  path: Schema.optional(Schema.Array(Schema.String)),
})
export const CiMeasurementObservation = Schema.Struct({
  ...optionalStrings(['id', 'label', 'group', 'description', 'measurementKind']),
  path: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.String,
  unit: Schema.String,
  value: Schema.Finite,
  dimensions: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]))),
  policy: Schema.optional(CiMeasurementGatePolicy),
  comparison: Schema.optional(Schema.Struct({
    mode: Schema.optional(Schema.String),
    ...optionalNumbers(['baseline', 'pairedSampleCount']),
  })),
  statistics: Schema.optional(Schema.Struct({
    ...optionalNumbers(['sampleCount', 'warmupCount', 'measuredSampleCount', 'successfulSampleCount',
      'min', 'max', 'median', 'p25', 'p75', 'p95', 'pairedSampleCount', 'pairedBaselineMedian',
      'pairedCurrentMedian', 'pairedDeltaMedian', 'pairedDeltaMin', 'pairedDeltaMax',
      'pairedDeltaP25', 'pairedDeltaP75', 'pairedDeltaMad']),
    pairedDeltaSamples: Schema.optional(Schema.Array(Schema.Finite)),
  })),
})
export const CiMeasurementArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(ciMeasurementSchemaVersion),
  generatedAt: Schema.String,
  producer: Schema.Struct({ name: Schema.String, version: Schema.Int, measurementProtocol: Schema.optional(Schema.String) }),
  subject: Schema.optional(Schema.Struct(optionalStrings(['repo', 'branchKind', 'ref', 'sha', 'headSha', 'baseSha', 'label']))),
  execution: Schema.optional(Schema.Struct({
    ...optionalStrings(['provider', 'workflow', 'job', 'runId', 'runAttempt', 'taskId', 'attemptId', 'traceId']),
    runner: Schema.optional(Schema.Struct(optionalStrings(['name', 'os', 'arch', 'class']))),
  })),
  target: CiMeasurementTarget,
  observations: Schema.Array(CiMeasurementObservation),
  artifacts: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, contentType: Schema.optional(Schema.String) }))),
  summary: Schema.optional(Schema.Unknown),
  details: Schema.optional(Schema.Unknown),
})
export type CiMeasurementArtifact = typeof CiMeasurementArtifact.Type
export type CiMeasurementObservation = typeof CiMeasurementObservation.Type
export type CiMeasurementTarget = typeof CiMeasurementTarget.Type

const ComparisonRow = Schema.Struct({
  status: Schema.String,
  target: CiMeasurementTarget,
  observation: CiMeasurementObservation,
  current: Schema.Finite,
  currentSamples: Schema.Finite,
  baselineSources: Schema.Finite,
  gatePolicy: CiMeasurementGatePolicy,
  comparisonMode: Schema.String,
  gateable: Schema.Boolean,
  gateReason: Schema.String,
  confidence: Schema.String,
  direction: Schema.String,
  ...optionalNumbers(['baseline', 'delta', 'ratio', 'semanticImpactScore', 'semanticWarnBudget',
    'semanticFailBudget', 'baselineRobustLower', 'baselineRobustUpper', 'baselineRobustTolerance',
    'currentRobustLower', 'currentRobustUpper', 'currentRobustTolerance', 'pairedSamples',
    'evidenceDelta', 'evidenceDeltaLower', 'evidenceDeltaUpper', 'evidenceDeltaTolerance',
    'pairedEvidenceQuantile', 'baselineMin', 'baselineMax', 'baselineP25', 'baselineP75', 'baselineP95', 'baselineMad']),
  budget: Schema.optional(CiMeasurementGatePolicy),
  semanticImpactKind: Schema.optional(Schema.String),
  withinBaselineRange: Schema.optional(Schema.Boolean),
  pairedEvidenceProtocol: Schema.optional(Schema.NullOr(Schema.String)),
})
export const CiMeasurementComparison = Schema.Struct({
  schemaVersion: Schema.Literal(ciMeasurementSchemaVersion),
  status: Schema.Literals(['skipped', 'pass', 'warn', 'fail', 'partial']),
  mode: Schema.Literals(['off', 'warn', 'fail']),
  ...optionalStrings(['currentDir', 'baselineDir']),
  readiness: Schema.optional(Schema.Struct({
    enforceable: Schema.Boolean,
    enabledCount: Schema.Finite,
    gateableCount: Schema.Finite,
    missingBaselineCount: Schema.Finite,
    lowBaselineCount: Schema.Finite,
    lowCurrentSampleCount: Schema.Finite,
    lowPairedSampleCount: Schema.Finite,
    missingPairedDeltaCount: Schema.Finite,
    nonGateableCount: Schema.Finite,
  })),
  comparisons: Schema.Record(Schema.String, ComparisonRow),
  baselineProvenance: Schema.optional(Schema.NullOr(Schema.Unknown)),
})
export type CiMeasurementComparison = typeof CiMeasurementComparison.Type

const CommentRow = Schema.Struct({
  status: Schema.String, target: Schema.String, observation: Schema.String, meaning: Schema.String,
  dimensions: Schema.String, baseline: Schema.String, current: Schema.String, delta: Schema.String,
  ratio: Schema.String, impact: Schema.String,
})
export const CiMeasurementCommentState = Schema.Struct({
  _tag: Schema.Literal(ciMeasurementCommentStateTag),
  schemaVersion: Schema.Literal(ciMeasurementSchemaVersion),
  title: Schema.String,
  runs: Schema.Array(Schema.Struct({
    commitSha: Schema.String, shortSha: Schema.String, generatedAt: Schema.String, status: Schema.String,
    mode: Schema.String, runUrl: Schema.optional(Schema.String), runAttempt: Schema.String,
    workflow: Schema.String, job: Schema.String, visibleRows: Schema.Array(CommentRow),
  })),
})
export type CiMeasurementCommentState = typeof CiMeasurementCommentState.Type

/** Structurally compatible with registry catalogs without coupling upstream to a downstream registry. */
export const ciMeasurementAuthority = {
  id: 'ci-measurements',
  owner: 'effect-utils',
  fragments: [
    { id: 'ci-measurement-artifact/v1', schema: CiMeasurementArtifact },
    { id: 'ci-measurement-comparison/v1', schema: CiMeasurementComparison },
    { id: 'ci-measurement-comment-state/v1', wireTag: ciMeasurementCommentStateTag, schema: CiMeasurementCommentState },
  ],
} as const

export const decodeCiMeasurementArtifact = Schema.decodeUnknownSync(CiMeasurementArtifact, { onExcessProperty: 'error' })
export const decodeCiMeasurementComparison = Schema.decodeUnknownSync(CiMeasurementComparison, { onExcessProperty: 'error' })
export const decodeCiMeasurementCommentState = Schema.decodeUnknownSync(CiMeasurementCommentState, { onExcessProperty: 'error' })


export const renderCiMeasurementValidators = (): string =>
  Object.entries({
    isCiMeasurementArtifact: CiMeasurementArtifact,
    isCiMeasurementComparison: CiMeasurementComparison,
    isCiMeasurementCommentState: CiMeasurementCommentState,
  }).map(([name, schema]) => renderJsonSchemaValidator(name, schema)).join('\n')
