import { Effect, Schema } from 'effect'

import {
  TrimmedNonEmptyString as NonEmptyString,
  NonNegativeVersion as Version,
} from '../primitives.ts'

const TagKeySegment = NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  Schema.annotate({ identifier: 'PtyTagSchema.TagKeySegment' }),
)

const TagKey = NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)),
  Schema.annotate({ identifier: 'PtyTagSchema.TagKey' }),
)

const TagNamespace = Schema.Union([TagKeySegment, Schema.Literals([':'])]).annotate({
  identifier: 'PtyTagSchema.TagNamespace',
})

const FirstPartySource = Schema.TaggedStruct('first-party', {
  vrs: NonEmptyString,
  module: NonEmptyString,
  steward: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.FirstPartySource' })

const ExternalMirrorSource = Schema.TaggedStruct('external-mirror', {
  /** Canonical upstream semantic authority, independent of the concrete locked source. */
  upstream: NonEmptyString,
  /** Exact repository locator whose source bytes were audited. */
  resolvedUpstream: NonEmptyString,
  sourcePaths: Schema.NonEmptyArray(NonEmptyString),
  /** Exact revision at the resolved repository whose source was audited. */
  verifiedAgainst: NonEmptyString,
  checkedAt: Schema.DateTimeUtcFromString,
  steward: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.ExternalMirrorSource' })

/** Provenance for a fragment, distinguishing owned definitions from audited external mirrors. */
export const SchemaSource = Schema.Union([FirstPartySource, ExternalMirrorSource]).annotate({
  identifier: 'PtyTagSchema.SchemaSource',
})

export type SchemaSource = typeof SchemaSource.Type

const MetadataSurface = Schema.Literals([
  'agent-spec.field',
  'agent-spec.resource',
  'agent-spec.meta',
  'agent-spec.task-tag',
  'pty.tag',
  'pty.state',
  'pty.event',
  'telemetry.attribute',
  'presentation.field',
]).annotate({ identifier: 'PtyTagSchema.MetadataSurface' })

/** Declares a metadata carrier and the value representation it exposes to readers and writers. */
export const MetadataSurfaceDefinition = Schema.Struct({
  id: MetadataSurface,
  description: NonEmptyString,
  semanticOwner: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.MetadataSurfaceDefinition' })

export type MetadataSurfaceDefinition = typeof MetadataSurfaceDefinition.Type

/** Stable field identity shared by definitions, profile constraints, and adopted values. */
export const MetadataFieldReference = Schema.Struct({
  surface: MetadataSurface,
  key: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.MetadataFieldReference' })

export type MetadataFieldReference = typeof MetadataFieldReference.Type

const StringValue = Schema.TaggedStruct('string', {
  nonEmpty: Schema.optional(Schema.Boolean),
}).annotate({ identifier: 'PtyTagSchema.StringValue' })

const BooleanStringValue = Schema.TaggedStruct('boolean-string', {}).annotate({
  identifier: 'PtyTagSchema.BooleanStringValue',
})

const IntegerStringValue = Schema.TaggedStruct('integer-string', {
  minimum: Schema.optional(Schema.Int),
  maximum: Schema.optional(Schema.Int),
}).annotate({ identifier: 'PtyTagSchema.IntegerStringValue' })

const TimestampValue = Schema.TaggedStruct('timestamp', {}).annotate({
  identifier: 'PtyTagSchema.TimestampValue',
})

const IdentifierValue = Schema.TaggedStruct('identifier', {
  brand: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.IdentifierValue' })

const EnumValue = Schema.TaggedStruct('enum', {
  values: Schema.NonEmptyArray(NonEmptyString),
}).annotate({ identifier: 'PtyTagSchema.EnumValue' })

const UrlValue = Schema.TaggedStruct('url', {}).annotate({
  identifier: 'PtyTagSchema.UrlValue',
})

const StructuredStringValue = Schema.TaggedStruct('structured-string', {
  schemaId: NonEmptyString,
  version: Version,
}).annotate({ identifier: 'PtyTagSchema.StructuredStringValue' })

/** Closed set of string encodings accepted on the PTY tag wire surface. */
export const TagValueSchema = Schema.Union([
  StringValue,
  BooleanStringValue,
  IntegerStringValue,
  TimestampValue,
  IdentifierValue,
  EnumValue,
  UrlValue,
  StructuredStringValue,
]).annotate({ identifier: 'PtyTagSchema.TagValueSchema' })

export type TagValueSchema = typeof TagValueSchema.Type

const NativeBooleanValue = Schema.TaggedStruct('native-boolean', {}).annotate({
  identifier: 'PtyTagSchema.NativeBooleanValue',
})

const NativeStringArrayValue = Schema.TaggedStruct('native-string-array', {
  nonEmpty: Schema.optional(Schema.Boolean),
  nonEmptyFirst: Schema.optional(Schema.Boolean),
}).annotate({ identifier: 'PtyTagSchema.NativeStringArrayValue' })

const NativeJsonValue = Schema.TaggedStruct('native-json', {}).annotate({
  identifier: 'PtyTagSchema.NativeJsonValue',
})

/** Source-surface values may be native typed data; PTY tag values remain TagValueSchema only. */
const MetadataValueSchema = Schema.Union([
  TagValueSchema,
  NativeBooleanValue,
  NativeStringArrayValue,
  NativeJsonValue,
]).annotate({ identifier: 'PtyTagSchema.MetadataValueSchema' })

/** Semantic contract for one field on a declared metadata surface. */
export const MetadataFieldDefinition = Schema.Struct({
  ref: MetadataFieldReference,
  description: NonEmptyString,
  value: MetadataValueSchema,
  semanticOwner: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.MetadataFieldDefinition' })

export type MetadataFieldDefinition = typeof MetadataFieldDefinition.Type

const CatalogLimitationSubject = Schema.Union([
  Schema.TaggedStruct('metadata-field', { field: MetadataFieldReference }),
  Schema.TaggedStruct('catalog-capability', { capability: NonEmptyString }),
]).annotate({ identifier: 'PtyTagSchema.CatalogLimitationSubject' })

/** Evidence-backed boundary where the catalog intentionally cannot make a stronger claim. */
export const CatalogLimitation = Schema.Struct({
  id: NonEmptyString,
  kind: Schema.Literals([
    'dynamic-target-unrepresented',
    'admission-regimes-unmodeled',
    'producer-proof-unlinked',
    'composer-invariant-unimplemented',
    'consumer-semantics-unrepresented',
  ]),
  subject: CatalogLimitationSubject,
  requiredCapability: NonEmptyString,
  description: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.CatalogLimitation' })

export type CatalogLimitation = typeof CatalogLimitation.Type

const ResolvedCatalogLimitation = Schema.Struct({
  fragmentId: NonEmptyString,
  id: NonEmptyString,
  kind: Schema.Literals([
    'dynamic-target-unrepresented',
    'admission-regimes-unmodeled',
    'producer-proof-unlinked',
    'composer-invariant-unimplemented',
    'consumer-semantics-unrepresented',
  ]),
  subject: CatalogLimitationSubject,
  requiredCapability: NonEmptyString,
  description: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.ResolvedCatalogLimitation' })

const TagLifecycle = Schema.Literals([
  'creation',
  'durable',
  'runtime-snapshot',
  'pty-mechanism',
]).annotate({ identifier: 'PtyTagSchema.TagLifecycle' })

const TagVisibility = Schema.Literals(['public', 'local-sensitive']).annotate({
  identifier: 'PtyTagSchema.TagVisibility',
})

const TagSecretMaterialPolicy = Schema.Literals(['forbidden']).annotate({
  identifier: 'PtyTagSchema.TagSecretMaterialPolicy',
})

const TagCardinality = Schema.Literals(['bounded', 'unbounded']).annotate({
  identifier: 'PtyTagSchema.TagCardinality',
})

const WriterPhase = Schema.Literals(['create', 'reconcile', 'launch', 'runtime']).annotate({
  identifier: 'PtyTagSchema.WriterPhase',
})

const CatalogPhase = Schema.Literals([
  'materialize',
  'create',
  'reconcile',
  'launch',
  'runtime',
  'author',
  'admission',
]).annotate({ identifier: 'PtyTagSchema.CatalogPhase' })

const WriterGrant = Schema.Struct({
  writer: NonEmptyString,
  phases: Schema.NonEmptyArray(WriterPhase),
  enforcement: Schema.Literals(['advisory', 'constructor', 'mediated']),
}).annotate({ identifier: 'PtyTagSchema.WriterGrant' })

const AdvisoryWriterGrant = Schema.Struct({
  writer: NonEmptyString,
  phases: Schema.NonEmptyArray(WriterPhase),
  enforcement: Schema.Literals(['advisory']),
}).annotate({ identifier: 'PtyTagSchema.AdvisoryWriterGrant' })

/** Adds an independently owned writer grant to an already canonical tag definition. */
export const WriterAugmentation = Schema.Struct({
  tagKey: TagKey,
  writers: Schema.NonEmptyArray(AdvisoryWriterGrant),
  description: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.WriterAugmentation' })

export type WriterAugmentation = typeof WriterAugmentation.Type

const ResolvedWriterAugmentation = Schema.Struct({
  fragmentId: NonEmptyString,
  tagKey: TagKey,
  writers: Schema.NonEmptyArray(AdvisoryWriterGrant),
  description: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.ResolvedWriterAugmentation' })

const Compatibility = Schema.Struct({
  introducedIn: Version,
  status: Schema.Literals(['experimental', 'stable', 'legacy']),
}).annotate({ identifier: 'PtyTagSchema.Compatibility' })

/** Reader/writer rollout policy for versioned profiles and derivations. */
const ContractCompatibility = Schema.Struct({
  ...Compatibility.fields,
  rollout: Schema.Struct({
    version: Version,
    order: Schema.Literals(['readers-before-writers', 'writers-before-readers', 'atomic']),
    reader: Schema.Struct({
      acceptedVersions: Schema.NonEmptyArray(Version),
      grandfatherPolicy: Schema.Literals(['accept-existing', 'repair-existing', 'reject-existing']),
    }),
    writer: Schema.Struct({
      emittedVersions: Schema.NonEmptyArray(Version),
      dualEmission: Schema.Boolean,
    }),
    retirement: Schema.Union([
      Schema.TaggedStruct('none', {}),
      Schema.TaggedStruct('condition', {
        afterVersion: Version,
        condition: NonEmptyString,
      }),
    ]),
  }),
}).annotate({ identifier: 'PtyTagSchema.ContractCompatibility' })

/** Versioned identity of an executable validator kept outside the neutral catalog DTO. */
export const RegisteredValueSchemaReference = Schema.Struct({
  id: NonEmptyString,
  version: Version,
}).annotate({ identifier: 'PtyTagSchema.RegisteredValueSchemaReference' })

/** Neutral declaration paired with a colocated executable validator by id and version. */
export const RegisteredValueSchemaDefinition = Schema.Struct({
  id: NonEmptyString,
  version: Version,
  input: Schema.Literals(['string', 'boolean', 'string-array']),
  description: NonEmptyString,
  semanticOwner: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.RegisteredValueSchemaDefinition' })

export type RegisteredValueSchemaDefinition = typeof RegisteredValueSchemaDefinition.Type

export type RegisteredValueSchemaReference = typeof RegisteredValueSchemaReference.Type

const MetadataLiteral = Schema.Union([
  Schema.String,
  Schema.Boolean,
  Schema.Array(Schema.String),
]).annotate({ identifier: 'PtyTagSchema.MetadataLiteral' })

const MetadataValueMatch = Schema.Union([
  Schema.TaggedStruct('fixed', { value: MetadataLiteral }),
  Schema.TaggedStruct('registered-schema', { schema: RegisteredValueSchemaReference }),
]).annotate({ identifier: 'PtyTagSchema.MetadataValueMatch' })

const ConsumerValueEffect = Schema.Union([
  Schema.TaggedStruct('reject-operation', {
    operation: NonEmptyString,
  }),
  Schema.TaggedStruct('require-tuple-validation', {
    policyId: NonEmptyString,
  }),
]).annotate({ identifier: 'PtyTagSchema.ConsumerValueEffect' })

/** Imports a semantic value into the catalog while preserving its owning field and consumer effect. */
export const AdoptedMetadataValue = Schema.Struct({
  id: NonEmptyString,
  version: Version,
  field: MetadataFieldReference,
  consumer: NonEmptyString,
  match: MetadataValueMatch,
  purpose: NonEmptyString,
  effect: ConsumerValueEffect,
  phases: Schema.NonEmptyArray(CatalogPhase),
  enforcement: Schema.Literals(['advisory', 'constructor', 'mediated']),
  compatibility: Compatibility,
  description: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.AdoptedMetadataValue' })

export type AdoptedMetadataValue = typeof AdoptedMetadataValue.Type

const Deprecation = Schema.Struct({
  sinceVersion: Version,
  replacement: Schema.optional(TagKey),
  removalAfter: Schema.optional(NonEmptyString),
}).annotate({ identifier: 'PtyTagSchema.Deprecation' })

const AliasDefinition = Schema.Struct({
  key: TagKey,
  compatibility: Compatibility,
  deprecation: Schema.optional(Deprecation),
}).annotate({ identifier: 'PtyTagSchema.AliasDefinition' })

const PatternSegmentName = NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/)),
  Schema.annotate({ identifier: 'PtyTagSchema.PatternSegmentName' }),
)

const LiteralPatternSegment = Schema.TaggedStruct('literal', {
  value: TagKeySegment,
}).annotate({ identifier: 'PtyTagSchema.LiteralPatternSegment' })

const CapturePatternSegment = Schema.TaggedStruct('capture', {
  name: PatternSegmentName,
  valueType: Schema.Literals(['uint', 'segment']),
}).annotate({ identifier: 'PtyTagSchema.CapturePatternSegment' })

/** Parsed pattern segment, either an exact literal or a typed capture. */
export const TagPatternSegment = Schema.Union([
  LiteralPatternSegment,
  CapturePatternSegment,
]).annotate({ identifier: 'PtyTagSchema.TagPatternSegment' })

export type TagPatternSegment = typeof TagPatternSegment.Type

/** Canonical parsed representation of a dot-delimited tag pattern. */
export const TagPattern = Schema.Struct({
  segments: Schema.NonEmptyArray(TagPatternSegment),
}).annotate({ identifier: 'PtyTagSchema.TagPattern' })

export type TagPattern = typeof TagPattern.Type

/**
 * Ergonomic authoring helper for the explicit pattern AST.
 *
 * The accepted grammar is a dot-separated sequence of literal segments and
 * named captures such as `rel.<index:uint>.kind`. Arbitrary regular
 * expressions and wildcard prefixes are intentionally not accepted.
 */
export const tagPattern = (input: string): TagPattern => {
  const segments = input.split('.').map((segment) => {
    const capture = /^<([A-Za-z][A-Za-z0-9_-]*):(uint|segment)>$/.exec(segment)
    if (capture !== null) {
      return {
        _tag: 'capture' as const,
        name: capture[1],
        valueType: capture[2],
      }
    }
    return { _tag: 'literal' as const, value: segment }
  })

  return Schema.decodeUnknownSync(TagPattern)({ segments })
}

/** Renders a parsed pattern into the canonical catalog spelling. */
export const formatTagPattern = (pattern: TagPattern): string =>
  pattern.segments
    .map((segment) =>
      segment._tag === 'literal' ? segment.value : `<${segment.name}:${segment.valueType}>`,
    )
    .join('.')

const TagDefinitionFields = {
  description: NonEmptyString,
  value: TagValueSchema,
  semanticOwner: NonEmptyString,
  authoritativeSource: MetadataFieldReference,
  lifecycle: TagLifecycle,
  writers: Schema.Array(WriterGrant),
  visibility: TagVisibility,
  secretMaterial: TagSecretMaterialPolicy,
  cardinality: TagCardinality,
  compatibility: Compatibility,
  aliases: Schema.Array(AliasDefinition),
  deprecation: Schema.optional(Deprecation),
}

/** Complete contract for one exact PTY tag key. */
export const ExactTagDefinition = Schema.TaggedStruct('exact', {
  ...TagDefinitionFields,
  key: TagKey,
}).annotate({ identifier: 'PtyTagSchema.ExactTagDefinition' })

export type ExactTagDefinition = typeof ExactTagDefinition.Type

/** Named typed-segment grammar, for example rel.<index:uint>.kind; never a regular expression. */
/** Complete contract for a family of keys admitted by one parsed pattern. */
export const PatternTagDefinition = Schema.TaggedStruct('pattern', {
  ...TagDefinitionFields,
  pattern: TagPattern,
  example: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.PatternTagDefinition' })

export type PatternTagDefinition = typeof PatternTagDefinition.Type

/** Catalog tag contract preserving whether identity is exact or pattern-based. */
export const TagDefinition = Schema.Union([ExactTagDefinition, PatternTagDefinition]).annotate({
  identifier: 'PtyTagSchema.TagDefinition',
})

export type TagDefinition = typeof TagDefinition.Type

/** Reference-safe identity of an exact or patterned tag definition without its contract fields. */
export const TagIdentity = Schema.Union([
  Schema.TaggedStruct('exact', { key: TagKey }),
  Schema.TaggedStruct('pattern', { pattern: TagPattern }),
]).annotate({ identifier: 'PtyTagSchema.TagIdentity' })

export type TagIdentity = typeof TagIdentity.Type

/** Alias resolved to its canonical tag identity while retaining compatibility metadata. */
export const ResolvedAliasDefinition = Schema.Struct({
  key: TagKey,
  canonical: TagIdentity,
  compatibility: Compatibility,
  deprecation: Schema.optional(Deprecation),
}).annotate({ identifier: 'PtyTagSchema.ResolvedAliasDefinition' })

export type ResolvedAliasDefinition = typeof ResolvedAliasDefinition.Type

/** Open namespace whose managed keys follow a declared grammar and semantic ownership. */
export const ExtensionNamespaceDefinition = Schema.Struct({
  prefix: NonEmptyString,
  grammar: NonEmptyString,
  description: NonEmptyString,
  semanticOwner: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.ExtensionNamespaceDefinition' })

export type ExtensionNamespaceDefinition = typeof ExtensionNamespaceDefinition.Type

/** Closed set of deterministic transformations that derive managed tags from declared inputs. */
export const DerivationTransform = Schema.Union([
  Schema.TaggedStruct('identity', {}),
  Schema.TaggedStruct('fixed', { value: Schema.String }),
  Schema.TaggedStruct('environment-expand', {}),
  Schema.TaggedStruct('template', { template: NonEmptyString }),
  Schema.TaggedStruct('implementation', { id: NonEmptyString, version: Version }),
  Schema.TaggedStruct('keyed-map', {
    targetSurface: Schema.Literals(['pty.tag']),
    keyAdmission: Schema.Literals(['catalog-tag']),
    variables: Schema.Array(
      Schema.Struct({
        name: NonEmptyString.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
        value: StringValue,
        secretMaterial: Schema.Literals(['forbidden']),
      }),
    ),
    expansion: Schema.Struct({
      syntax: Schema.Literals(['dollar-variable']),
      passes: Schema.Literals([1]),
      shell: Schema.Literals([false]),
      unresolved: Schema.Literals(['invalid']),
      maximumOutputLength: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
    collision: Schema.Literals(['invalid']),
  }),
]).annotate({ identifier: 'PtyTagSchema.DerivationTransform' })

const DerivationPredicate = Schema.Union([
  Schema.TaggedStruct('present', { field: MetadataFieldReference }),
  Schema.TaggedStruct('equals', { field: MetadataFieldReference, value: MetadataLiteral }),
]).annotate({ identifier: 'PtyTagSchema.DerivationPredicate' })

/** Versioned rule connecting source fields to target tags through a deterministic transform. */
export const DerivationRule = Schema.TaggedStruct('derivation', {
  id: NonEmptyString,
  version: Version,
  compatibility: ContractCompatibility,
  source: Schema.NonEmptyArray(MetadataFieldReference),
  target: Schema.optional(MetadataFieldReference),
  transform: DerivationTransform,
  when: Schema.Array(DerivationPredicate),
  onSourceAbsent: Schema.Literals(['omit-target', 'remove-target', 'no-op', 'invalid']),
  producer: NonEmptyString,
  phases: Schema.NonEmptyArray(
    Schema.Literals(['materialize', 'create', 'reconcile', 'launch', 'runtime']),
  ),
  lossiness: Schema.Literals(['identity', 'renamed', 'transformed', 'aggregated', 'terminal']),
}).annotate({ identifier: 'PtyTagSchema.DerivationRule' })

export type DerivationRule = typeof DerivationRule.Type

const ProfileSelector = Schema.Union([
  Schema.TaggedStruct('metadata-field', {
    field: MetadataFieldReference,
    equals: Schema.optional(MetadataLiteral),
  }),
  Schema.TaggedStruct('declared-producer', {
    producer: NonEmptyString,
  }),
  Schema.TaggedStruct('authoritative-declaration', { field: MetadataFieldReference }),
]).annotate({ identifier: 'PtyTagSchema.ProfileSelector' })

const FieldIdentity = Schema.Union([
  Schema.TaggedStruct('exact', { field: MetadataFieldReference }),
  Schema.TaggedStruct('pattern', { surface: MetadataSurface, pattern: TagPattern }),
]).annotate({ identifier: 'PtyTagSchema.FieldIdentity' })

const ProfileValueConstraint = Schema.Union([
  Schema.TaggedStruct('fixed', { value: MetadataLiteral }),
  Schema.TaggedStruct('registered-schema', { schema: RegisteredValueSchemaReference }),
  Schema.TaggedStruct('adopted-value', { semanticId: NonEmptyString }),
]).annotate({ identifier: 'PtyTagSchema.ProfileValueConstraint' })

const ProfileConstraint = Schema.Struct({
  target: FieldIdentity,
  presence: Schema.Literals(['required', 'optional', 'forbidden']),
  value: Schema.optional(ProfileValueConstraint),
  occurrences: Schema.optional(
    Schema.Struct({
      minimum: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      maximum: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  when: Schema.optional(DerivationPredicate),
}).annotate({ identifier: 'PtyTagSchema.ProfileConstraint' })

const ProducerStage = Schema.Struct({
  producer: NonEmptyString,
  phases: Schema.NonEmptyArray(CatalogPhase),
  enforcement: Schema.Literals(['advisory', 'constructor', 'mediated']),
}).annotate({ identifier: 'PtyTagSchema.ProducerStage' })

/** Constraints applied when an independently declared producer identity selects this profile. */
export const ProducerProfile = Schema.Struct({
  id: NonEmptyString,
  version: Version,
  compatibility: ContractCompatibility,
  producers: Schema.NonEmptyArray(ProducerStage),
  selector: ProfileSelector,
  constraints: Schema.NonEmptyArray(ProfileConstraint),
}).annotate({ identifier: 'PtyTagSchema.ProducerProfile' })

export type ProducerProfile = typeof ProducerProfile.Type

/** Independently owned catalog contribution composed only after namespace and reference checks. */
export const SchemaFragment = Schema.Struct({
  id: NonEmptyString,
  version: Version,
  description: NonEmptyString,
  source: SchemaSource,
  namespaces: Schema.Array(TagNamespace),
  extensionNamespaces: Schema.Array(ExtensionNamespaceDefinition),
  metadataSurfaces: Schema.Array(MetadataSurfaceDefinition),
  metadataFields: Schema.Array(MetadataFieldDefinition),
  tags: Schema.Array(TagDefinition),
  writerAugmentations: Schema.Array(WriterAugmentation).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  registeredValueSchemas: Schema.Array(RegisteredValueSchemaDefinition).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  adoptedMetadataValues: Schema.Array(AdoptedMetadataValue).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  limitations: Schema.Array(CatalogLimitation).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  profiles: Schema.Array(ProducerProfile),
  derivations: Schema.Array(DerivationRule),
}).annotate({ identifier: 'PtyTagSchema.SchemaFragment' })

export type SchemaFragment = typeof SchemaFragment.Type

/**
 * Explicit composition authority for a first-segment PTY tag namespace.
 *
 * A fragment whose `namespaces` contains `namespace` may define tags in that
 * namespace only when it is the owner or one of these delegates. References,
 * profiles, derivations, and writer augmentations remain ref-only and require
 * no namespace claim.
 */
export const NamespaceAuthority = Schema.Struct({
  namespace: TagNamespace,
  ownerFragmentId: NonEmptyString,
  delegateFragmentIds: Schema.Array(NonEmptyString),
}).annotate({ identifier: 'PtyTagSchema.NamespaceAuthority' })

export type NamespaceAuthority = typeof NamespaceAuthority.Type

/** Exact original locator, resolved locator, and revision used to audit an external mirror. */
export const ExternalSourcePin = Schema.Struct({
  /** Original flake locator, used as the canonical upstream authority key. */
  original: NonEmptyString,
  /** Concrete locked locator from which source bytes are fetched. */
  locked: NonEmptyString,
  revision: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.ExternalSourcePin' })

export type ExternalSourcePin = typeof ExternalSourcePin.Type

/** Unresolved fragment set and external pins supplied to the catalog composition boundary. */
export const CompositionInput = Schema.Struct({
  schemaVersion: Schema.Literals([2]),
  externalPins: Schema.Record(NonEmptyString, ExternalSourcePin),
  fragments: Schema.Array(SchemaFragment),
  namespaceAuthorities: Schema.Array(NamespaceAuthority).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
}).annotate({ identifier: 'PtyTagSchema.CompositionInput' })

/** Decoded composition input with namespace authorities accepted as one or many declarations. */
export type CompositionInput = Omit<typeof CompositionInput.Type, 'namespaceAuthorities'> & {
  readonly namespaceAuthorities?: ReadonlyArray<NamespaceAuthority>
}

/** Collision-free catalog produced after all fragments, aliases, references, and profiles validate. */
export const ResolvedCatalog = Schema.Struct({
  schemaVersion: Schema.Literals([2]),
  externalPins: Schema.Record(NonEmptyString, ExternalSourcePin),
  fragments: Schema.Array(SchemaFragment),
  namespaceAuthorities: Schema.Array(NamespaceAuthority),
  extensionNamespaces: Schema.Array(ExtensionNamespaceDefinition),
  metadataSurfaces: Schema.Array(MetadataSurfaceDefinition),
  metadataFields: Schema.Array(MetadataFieldDefinition),
  tags: Schema.Array(TagDefinition),
  writerAugmentations: Schema.Array(ResolvedWriterAugmentation),
  registeredValueSchemas: Schema.Array(RegisteredValueSchemaDefinition),
  adoptedMetadataValues: Schema.Array(AdoptedMetadataValue),
  limitations: Schema.Array(ResolvedCatalogLimitation),
  profiles: Schema.Array(ProducerProfile),
  aliases: Schema.Array(ResolvedAliasDefinition),
  derivations: Schema.Array(DerivationRule),
}).annotate({ identifier: 'PtyTagSchema.ResolvedCatalog' })

export type ResolvedCatalog = typeof ResolvedCatalog.Type

/** Decode author input at the DSL boundary; callers never assert decoded types. */
export const defineSchemaFragment = (input: typeof SchemaFragment.Encoded): SchemaFragment =>
  Schema.decodeSync(SchemaFragment)(input)
