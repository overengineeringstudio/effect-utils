import { Result, Schema } from 'effect'

import { compareText } from '../primitives.ts'
import { formatTagPattern } from './schema.ts'
import type {
  CompositionInput,
  ResolvedAliasDefinition,
  ResolvedCatalog,
  SchemaFragment,
  TagDefinition,
  TagIdentity,
  TagPattern,
  TagPatternSegment,
} from './schema.ts'

class DuplicateFragmentIdError extends Schema.TaggedError<DuplicateFragmentIdError>()(
  'DuplicateFragmentIdError',
  {
    fragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class TagCollisionError extends Schema.TaggedError<TagCollisionError>()('TagCollisionError', {
  identity: Schema.String,
  firstFragmentId: Schema.String,
  secondFragmentId: Schema.String,
  message: Schema.String,
}) {}

class PatternOverlapError extends Schema.TaggedError<PatternOverlapError>()('PatternOverlapError', {
  firstIdentity: Schema.String,
  secondIdentity: Schema.String,
  firstFragmentId: Schema.String,
  secondFragmentId: Schema.String,
  message: Schema.String,
}) {}

class DefinitionCollisionError extends Schema.TaggedError<DefinitionCollisionError>()(
  'DefinitionCollisionError',
  {
    kind: Schema.Literals(['extension-namespace', 'metadata-surface', 'metadata-field']),
    identity: Schema.String,
    firstFragmentId: Schema.String,
    secondFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class DuplicateNamespaceAuthorityError extends Schema.TaggedError<DuplicateNamespaceAuthorityError>()(
  'DuplicateNamespaceAuthorityError',
  {
    namespace: Schema.String,
    firstOwnerFragmentId: Schema.String,
    secondOwnerFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class InvalidNamespaceAuthorityError extends Schema.TaggedError<InvalidNamespaceAuthorityError>()(
  'InvalidNamespaceAuthorityError',
  {
    namespace: Schema.String,
    fragmentId: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

class NamespaceDefinitionOutsideClaimError extends Schema.TaggedError<NamespaceDefinitionOutsideClaimError>()(
  'NamespaceDefinitionOutsideClaimError',
  {
    fragmentId: Schema.String,
    identity: Schema.String,
    namespace: Schema.String,
    message: Schema.String,
  },
) {}

class DerivationCollisionError extends Schema.TaggedError<DerivationCollisionError>()(
  'DerivationCollisionError',
  {
    derivationId: Schema.String,
    firstFragmentId: Schema.String,
    secondFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class InvalidDerivationShapeError extends Schema.TaggedError<InvalidDerivationShapeError>()(
  'InvalidDerivationShapeError',
  {
    derivationId: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

class MissingExternalPinError extends Schema.TaggedError<MissingExternalPinError>()(
  'MissingExternalPinError',
  {
    fragmentId: Schema.String,
    upstream: Schema.String,
    message: Schema.String,
  },
) {}

class StaleExternalPinError extends Schema.TaggedError<StaleExternalPinError>()(
  'StaleExternalPinError',
  {
    fragmentId: Schema.String,
    upstream: Schema.String,
    verifiedLocator: Schema.String,
    verifiedAgainst: Schema.String,
    actualLocator: Schema.String,
    actualRevision: Schema.String,
    message: Schema.String,
  },
) {}

class ExternalAuthorityMismatchError extends Schema.TaggedError<ExternalAuthorityMismatchError>()(
  'ExternalAuthorityMismatchError',
  {
    fragmentId: Schema.String,
    upstream: Schema.String,
    originalLocator: Schema.String,
    message: Schema.String,
  },
) {}

class UnknownWriterAugmentationTargetError extends Schema.TaggedError<UnknownWriterAugmentationTargetError>()(
  'UnknownWriterAugmentationTargetError',
  {
    fragmentId: Schema.String,
    tagKey: Schema.String,
    message: Schema.String,
  },
) {}

class DuplicateLimitationIdError extends Schema.TaggedError<DuplicateLimitationIdError>()(
  'DuplicateLimitationIdError',
  {
    limitationId: Schema.String,
    firstFragmentId: Schema.String,
    secondFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class UnknownLimitationSourceError extends Schema.TaggedError<UnknownLimitationSourceError>()(
  'UnknownLimitationSourceError',
  {
    fragmentId: Schema.String,
    limitationId: Schema.String,
    source: Schema.String,
    message: Schema.String,
  },
) {}

class AdoptedValueCollisionError extends Schema.TaggedError<AdoptedValueCollisionError>()(
  'AdoptedValueCollisionError',
  {
    semanticId: Schema.String,
    firstFragmentId: Schema.String,
    secondFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class AdoptedValueOverlapError extends Schema.TaggedError<AdoptedValueOverlapError>()(
  'AdoptedValueOverlapError',
  {
    firstSemanticId: Schema.String,
    secondSemanticId: Schema.String,
    identity: Schema.String,
    message: Schema.String,
  },
) {}

class AdoptedValueIntersectionIndeterminateError extends Schema.TaggedError<AdoptedValueIntersectionIndeterminateError>()(
  'AdoptedValueIntersectionIndeterminateError',
  {
    firstSemanticId: Schema.String,
    secondSemanticId: Schema.String,
    field: Schema.String,
    consumer: Schema.String,
    message: Schema.String,
  },
) {}

class UnknownCatalogReferenceError extends Schema.TaggedError<UnknownCatalogReferenceError>()(
  'UnknownCatalogReferenceError',
  {
    subject: Schema.String,
    referenceKind: Schema.Literals([
      'metadata-surface',
      'metadata-field',
      'registered-value-schema',
      'adopted-value',
    ]),
    reference: Schema.String,
    message: Schema.String,
  },
) {}

class MetadataValueDomainMismatchError extends Schema.TaggedError<MetadataValueDomainMismatchError>()(
  'MetadataValueDomainMismatchError',
  {
    subject: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

class ProducerProfileCollisionError extends Schema.TaggedError<ProducerProfileCollisionError>()(
  'ProducerProfileCollisionError',
  {
    profileId: Schema.String,
    firstFragmentId: Schema.String,
    secondFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class InvalidProfileConstraintError extends Schema.TaggedError<InvalidProfileConstraintError>()(
  'InvalidProfileConstraintError',
  {
    profileId: Schema.String,
    target: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

class InvalidContractCompatibilityError extends Schema.TaggedError<InvalidContractCompatibilityError>()(
  'InvalidContractCompatibilityError',
  {
    definitionKind: Schema.Literals(['profile', 'derivation']),
    definitionId: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

class RegisteredValueSchemaCollisionError extends Schema.TaggedError<RegisteredValueSchemaCollisionError>()(
  'RegisteredValueSchemaCollisionError',
  {
    schema: Schema.String,
    firstFragmentId: Schema.String,
    secondFragmentId: Schema.String,
    message: Schema.String,
  },
) {}

class ProfileSelectorDomainMismatchError extends Schema.TaggedError<ProfileSelectorDomainMismatchError>()(
  'ProfileSelectorDomainMismatchError',
  {
    profileId: Schema.String,
    field: Schema.String,
    value: Schema.Unknown,
    expectedDomain: Schema.String,
    message: Schema.String,
  },
) {}

class IncompatibleProducerProfilesError extends Schema.TaggedError<IncompatibleProducerProfilesError>()(
  'IncompatibleProducerProfilesError',
  {
    firstProfileId: Schema.String,
    firstFragmentId: Schema.String,
    secondProfileId: Schema.String,
    secondFragmentId: Schema.String,
    target: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

/** Closed failure channel emitted before an invalid or ambiguous catalog can be resolved. */
export type CompositionError =
  | DuplicateFragmentIdError
  | TagCollisionError
  | PatternOverlapError
  | DefinitionCollisionError
  | DuplicateNamespaceAuthorityError
  | InvalidNamespaceAuthorityError
  | NamespaceDefinitionOutsideClaimError
  | DerivationCollisionError
  | InvalidDerivationShapeError
  | MissingExternalPinError
  | ExternalAuthorityMismatchError
  | StaleExternalPinError
  | UnknownWriterAugmentationTargetError
  | DuplicateLimitationIdError
  | UnknownLimitationSourceError
  | AdoptedValueCollisionError
  | AdoptedValueOverlapError
  | AdoptedValueIntersectionIndeterminateError
  | UnknownCatalogReferenceError
  | MetadataValueDomainMismatchError
  | ProducerProfileCollisionError
  | InvalidProfileConstraintError
  | InvalidContractCompatibilityError
  | RegisteredValueSchemaCollisionError
  | ProfileSelectorDomainMismatchError
  | IncompatibleProducerProfilesError

const canonicalTagIdentity = (tag: TagDefinition): TagIdentity =>
  tag._tag === 'exact' ? { _tag: 'exact', key: tag.key } : { _tag: 'pattern', pattern: tag.pattern }

const formatTagIdentity = (identity: TagIdentity): string =>
  identity._tag === 'exact'
    ? `exact:${identity.key}`
    : `pattern:${formatTagPattern(identity.pattern)}`

const isUnsignedInteger = (value: string): boolean => /^\d+$/.test(value)

const segmentMatches = (args: {
  readonly segment: TagPatternSegment
  readonly value: string
}): boolean =>
  args.segment._tag === 'literal'
    ? args.segment.value === args.value
    : args.segment.valueType === 'segment'
      ? args.value.length > 0
      : isUnsignedInteger(args.value)

/** Tests an exact key against literal segments and the catalog's typed capture semantics. */
export const patternMatchesExact = (args: {
  readonly pattern: TagPattern
  readonly key: string
}): boolean => {
  const keySegments = args.key.split('.')
  return (
    args.pattern.segments.length === keySegments.length &&
    args.pattern.segments.every((segment, index) =>
      segmentMatches({ segment, value: keySegments[index] ?? '' }),
    )
  )
}

const segmentsOverlap = (args: {
  readonly left: TagPatternSegment
  readonly right: TagPatternSegment
}): boolean => {
  if (args.left._tag === 'literal')
    return segmentMatches({ segment: args.right, value: args.left.value })
  if (args.right._tag === 'literal')
    return segmentMatches({ segment: args.left, value: args.right.value })

  // `uint` is a non-empty subset of `segment`, so every pair of capture kinds intersects.
  return true
}

const patternsOverlap = (args: {
  readonly left: TagPattern
  readonly right: TagPattern
}): boolean =>
  args.left.segments.length === args.right.segments.length &&
  args.left.segments.every((segment, index) => {
    const rightSegment = args.right.segments[index]
    return rightSegment !== undefined && segmentsOverlap({ left: segment, right: rightSegment })
  })

const compareTagDefinitions = (args: {
  readonly left: TagDefinition
  readonly right: TagDefinition
}): number =>
  compareText({
    left: formatTagIdentity(canonicalTagIdentity(args.left)),
    right: formatTagIdentity(canonicalTagIdentity(args.right)),
  })

const compareById = (args: {
  readonly left: SchemaFragment
  readonly right: SchemaFragment
}): number => compareText({ left: args.left.id, right: args.right.id })

type TagClaim = {
  readonly identity: TagIdentity
  readonly fragmentId: string
}

const validateContractCompatibility = (args: {
  readonly definitionKind: 'profile' | 'derivation'
  readonly definition: Pick<SchemaFragment['profiles'][number], 'id' | 'version' | 'compatibility'>
}): InvalidContractCompatibilityError | undefined => {
  const { compatibility, id, version } = args.definition
  const { rollout } = compatibility
  const fail = (reason: string) =>
    new InvalidContractCompatibilityError({
      definitionKind: args.definitionKind,
      definitionId: id,
      reason,
      message: `${args.definitionKind} ${id} has contradictory compatibility policy: ${reason}`,
    })
  if (!rollout.reader.acceptedVersions.includes(version))
    return fail('current-version-not-accepted')
  if (!rollout.writer.emittedVersions.includes(version)) return fail('current-version-not-emitted')
  if (rollout.writer.dualEmission !== rollout.writer.emittedVersions.length > 1) {
    return fail('dual-emission-does-not-match-emitted-versions')
  }
  if (
    rollout.order === 'readers-before-writers' &&
    rollout.reader.grandfatherPolicy === 'reject-existing'
  ) {
    return fail('readers-first-cannot-reject-existing-records')
  }
  if (compatibility.status === 'legacy' && rollout.retirement._tag === 'none') {
    return fail('legacy-contract-requires-retirement-condition')
  }
  if (rollout.retirement._tag === 'condition' && rollout.retirement.afterVersion <= version) {
    return fail('retirement-must-follow-current-version')
  }
  return undefined
}

type MetadataFieldValue = SchemaFragment['metadataFields'][number]['value']
type MetadataLiteralValue = string | boolean | ReadonlyArray<string>
type AdoptedMetadataValue = SchemaFragment['adoptedMetadataValues'][number]
type ProfileSelector = SchemaFragment['profiles'][number]['selector']
type ProfileConstraint = SchemaFragment['profiles'][number]['constraints'][number]

const fieldDomain = (value: MetadataFieldValue) =>
  value._tag === 'native-boolean'
    ? 'boolean'
    : value._tag === 'native-string-array'
      ? 'string-array'
      : value._tag === 'native-json'
        ? 'json'
        : 'string'

const literalDomain = (value: MetadataLiteralValue) =>
  typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'string-array'

const fixedValueAccepted = (args: {
  readonly schema: MetadataFieldValue
  readonly literal: MetadataLiteralValue
}) => {
  if (fieldDomain(args.schema) !== literalDomain(args.literal)) return false
  if (Array.isArray(args.literal)) {
    return (
      args.schema._tag === 'native-string-array' &&
      (args.schema.nonEmpty !== true || args.literal.length > 0) &&
      (args.schema.nonEmptyFirst !== true || (args.literal[0]?.length ?? 0) > 0)
    )
  }
  if (typeof args.literal !== 'string') return true
  switch (args.schema._tag) {
    case 'string':
      return args.schema.nonEmpty !== true || args.literal.length > 0
    case 'enum':
      return args.schema.values.includes(args.literal)
    case 'integer-string': {
      if (!/^-?\d+$/.test(args.literal)) return false
      const parsed = Number(args.literal)
      return (
        (args.schema.minimum === undefined || parsed >= args.schema.minimum) &&
        (args.schema.maximum === undefined || parsed <= args.schema.maximum)
      )
    }
    case 'url':
      return URL.canParse(args.literal)
    default:
      return true
  }
}

const matchIdentity = (semantic: AdoptedMetadataValue) =>
  semantic.match._tag === 'fixed'
    ? `fixed:${JSON.stringify(semantic.match.value)}`
    : `schema:${semantic.match.schema.id}@${semantic.match.schema.version}`

const literalIdentity = (value: MetadataLiteralValue) => JSON.stringify(value)

const selectorsMayOverlap = (args: {
  readonly left: ProfileSelector
  readonly right: ProfileSelector
}) => {
  if (args.left._tag === 'declared-producer' && args.right._tag === 'declared-producer') {
    return args.left.producer === args.right.producer
  }
  if (args.left._tag === 'metadata-field' && args.right._tag === 'metadata-field') {
    const sameField =
      args.left.field.surface === args.right.field.surface &&
      args.left.field.key === args.right.field.key
    if (
      sameField &&
      args.left.equals !== undefined &&
      args.right.equals !== undefined &&
      literalIdentity(args.left.equals) !== literalIdentity(args.right.equals)
    ) {
      return false
    }
  }
  return true
}

const occurrenceInterval = (constraint: ProfileConstraint) => ({
  minimum: constraint.occurrences?.minimum ?? (constraint.presence === 'required' ? 1 : 0),
  maximum: constraint.occurrences?.maximum ?? (constraint.presence === 'forbidden' ? 0 : Infinity),
})

const predicatesAreDisjoint = (args: {
  readonly left: ProfileConstraint['when']
  readonly right: ProfileConstraint['when']
}) =>
  args.left?._tag === 'equals' &&
  args.right?._tag === 'equals' &&
  args.left.field.surface === args.right.field.surface &&
  args.left.field.key === args.right.field.key &&
  literalIdentity(args.left.value) !== literalIdentity(args.right.value)

const implicitSelectorConstraint = (selector: ProfileSelector): ProfileConstraint | undefined => {
  if (selector._tag === 'declared-producer') return undefined
  return {
    target: { _tag: 'exact', field: selector.field },
    presence: 'required',
    ...(selector._tag === 'metadata-field' && selector.equals !== undefined
      ? { value: { _tag: 'fixed' as const, value: selector.equals } }
      : {}),
  }
}

const formatFieldIdentity = (target: ProfileConstraint['target']) =>
  target._tag === 'exact'
    ? `${target.field.surface}:${target.field.key}`
    : `${target.surface}:${formatTagPattern(target.pattern)}`

const profileRequirements = (profile: SchemaFragment['profiles'][number]) => {
  const implicit = implicitSelectorConstraint(profile.selector)
  return implicit === undefined ? profile.constraints : [implicit, ...profile.constraints]
}

/** Validates and resolves fragment ownership, references, overlaps, profiles, and external pins. */
export const composeCatalog = (
  input: CompositionInput,
): Result.Result<ResolvedCatalog, CompositionError> => {
  const namespaceAuthorities = input.namespaceAuthorities ?? []
  const fragmentOwners = new Map<string, string>()
  const exactTagOwners = new Map<string, TagClaim>()
  const patternTagClaims: Array<
    TagClaim & { readonly identity: TagIdentity & { _tag: 'pattern' } }
  > = []
  const derivationOwners = new Map<string, string>()
  const adoptedValueOwners = new Map<string, string>()
  const profileOwners = new Map<string, string>()
  const registeredValueSchemaOwners = new Map<string, string>()
  const extensionNamespaceOwners = new Map<string, string>()
  const metadataSurfaceOwners = new Map<string, string>()
  const metadataFieldOwners = new Map<string, string>()

  const fragmentsById = new Map(input.fragments.map((fragment) => [fragment.id, fragment]))
  const claimantsByNamespace = new Map<string, Array<string>>()
  for (const fragment of input.fragments) {
    const seenClaims = new Set<string>()
    for (const namespace of fragment.namespaces) {
      if (seenClaims.has(namespace)) {
        return Result.fail(
          new InvalidNamespaceAuthorityError({
            namespace,
            fragmentId: fragment.id,
            reason: 'duplicate-fragment-claim',
            message: `Fragment ${fragment.id} claims namespace ${namespace} more than once`,
          }),
        )
      }
      seenClaims.add(namespace)
      const claimants = claimantsByNamespace.get(namespace) ?? []
      claimants.push(fragment.id)
      claimantsByNamespace.set(namespace, claimants)
    }

    const claimed = new Set(fragment.namespaces)
    for (const tag of fragment.tags) {
      const identities: ReadonlyArray<TagIdentity> = [
        canonicalTagIdentity(tag),
        ...tag.aliases.map((alias): TagIdentity => ({ _tag: 'exact', key: alias.key })),
      ]
      for (const identity of identities) {
        const namespace =
          identity._tag === 'exact'
            ? (identity.key.split('.')[0] ?? '')
            : identity.pattern.segments[0]?._tag === 'literal'
              ? identity.pattern.segments[0].value
              : ''
        if (namespace.length === 0 || !claimed.has(namespace)) {
          return Result.fail(
            new NamespaceDefinitionOutsideClaimError({
              fragmentId: fragment.id,
              identity: formatTagIdentity(identity),
              namespace,
              message:
                namespace.length === 0
                  ? `Tag definition ${formatTagIdentity(identity)} in ${fragment.id} has no governable literal first segment`
                  : `Tag definition ${formatTagIdentity(identity)} in ${fragment.id} is outside its claimed namespaces`,
            }),
          )
        }
      }
    }
  }

  const namespaceAuthorityByName = new Map<string, (typeof namespaceAuthorities)[number]>()
  for (const authority of namespaceAuthorities) {
    const existing = namespaceAuthorityByName.get(authority.namespace)
    if (existing !== undefined) {
      return Result.fail(
        new DuplicateNamespaceAuthorityError({
          namespace: authority.namespace,
          firstOwnerFragmentId: existing.ownerFragmentId,
          secondOwnerFragmentId: authority.ownerFragmentId,
          message: `Namespace ${authority.namespace} has more than one authority declaration`,
        }),
      )
    }
    namespaceAuthorityByName.set(authority.namespace, authority)

    const participants = [authority.ownerFragmentId, ...authority.delegateFragmentIds]
    const uniqueParticipants = new Set(participants)
    if (uniqueParticipants.size !== participants.length) {
      return Result.fail(
        new InvalidNamespaceAuthorityError({
          namespace: authority.namespace,
          fragmentId: authority.ownerFragmentId,
          reason: 'duplicate-participant',
          message: `Namespace ${authority.namespace} authority repeats an owner or delegate`,
        }),
      )
    }
    for (const fragmentId of participants) {
      const fragment = fragmentsById.get(fragmentId)
      if (fragment === undefined || !fragment.namespaces.includes(authority.namespace)) {
        return Result.fail(
          new InvalidNamespaceAuthorityError({
            namespace: authority.namespace,
            fragmentId,
            reason: fragment === undefined ? 'unknown-fragment' : 'participant-without-claim',
            message:
              fragment === undefined
                ? `Namespace ${authority.namespace} authority references unknown fragment ${fragmentId}`
                : `Namespace ${authority.namespace} authority participant ${fragmentId} does not claim that namespace`,
          }),
        )
      }
    }
  }

  for (const [namespace, claimants] of claimantsByNamespace) {
    const authority = namespaceAuthorityByName.get(namespace)
    if (claimants.length === 1 && authority === undefined) continue
    if (authority === undefined) {
      return Result.fail(
        new DuplicateNamespaceAuthorityError({
          namespace,
          firstOwnerFragmentId: claimants[0] ?? 'unknown',
          secondOwnerFragmentId: claimants[1] ?? 'unknown',
          message: `Namespace ${namespace} is claimed by multiple fragments without an explicit owner and delegation`,
        }),
      )
    }
    const authorized = new Set([authority.ownerFragmentId, ...authority.delegateFragmentIds])
    const missing = claimants.find((fragmentId) => !authorized.has(fragmentId))
    if (missing !== undefined || authorized.size !== claimants.length) {
      return Result.fail(
        new InvalidNamespaceAuthorityError({
          namespace,
          fragmentId: missing ?? authority.ownerFragmentId,
          reason:
            missing === undefined
              ? 'authority-participant-without-definition-claim'
              : 'unauthorized-claim',
          message:
            missing === undefined
              ? `Namespace ${namespace} authority lists a participant that does not define in the namespace`
              : `Fragment ${missing} claims namespace ${namespace} without owner delegation`,
        }),
      )
    }
  }

  const resolvedNamespaceAuthorities = [...claimantsByNamespace.entries()].map(
    ([namespace, claimants]) => {
      const explicit = namespaceAuthorityByName.get(namespace)
      return (
        explicit ?? {
          namespace,
          ownerFragmentId: claimants[0] ?? 'unknown',
          delegateFragmentIds: [],
        }
      )
    },
  )

  const checkDefinitionCollision = (args: {
    readonly owners: Map<string, string>
    readonly kind: 'extension-namespace' | 'metadata-surface' | 'metadata-field'
    readonly identity: string
    readonly fragmentId: string
  }): DefinitionCollisionError | undefined => {
    const existingOwner = args.owners.get(args.identity)
    if (existingOwner !== undefined) {
      return new DefinitionCollisionError({
        kind: args.kind,
        identity: args.identity,
        firstFragmentId: existingOwner,
        secondFragmentId: args.fragmentId,
        message: `${args.kind} identity ${args.identity} collides between ${existingOwner} and ${args.fragmentId}`,
      })
    }
    args.owners.set(args.identity, args.fragmentId)
    return undefined
  }

  for (const fragment of input.fragments) {
    const existingFragment = fragmentOwners.get(fragment.id)
    if (existingFragment !== undefined) {
      return Result.fail(
        new DuplicateFragmentIdError({
          fragmentId: fragment.id,
          message: `Fragment id ${fragment.id} is defined more than once`,
        }),
      )
    }
    fragmentOwners.set(fragment.id, fragment.id)

    for (const namespace of fragment.extensionNamespaces) {
      const collision = checkDefinitionCollision({
        owners: extensionNamespaceOwners,
        kind: 'extension-namespace',
        identity: namespace.prefix,
        fragmentId: fragment.id,
      })
      if (collision !== undefined) return Result.fail(collision)
    }

    for (const surface of fragment.metadataSurfaces) {
      const collision = checkDefinitionCollision({
        owners: metadataSurfaceOwners,
        kind: 'metadata-surface',
        identity: surface.id,
        fragmentId: fragment.id,
      })
      if (collision !== undefined) return Result.fail(collision)
    }

    for (const field of fragment.metadataFields) {
      const identity = `${field.ref.surface}:${field.ref.key}`
      const collision = checkDefinitionCollision({
        owners: metadataFieldOwners,
        kind: 'metadata-field',
        identity,
        fragmentId: fragment.id,
      })
      if (collision !== undefined) return Result.fail(collision)
    }

    if (fragment.source._tag === 'external-mirror') {
      const actualPin = input.externalPins[fragment.source.upstream]
      if (actualPin === undefined) {
        return Result.fail(
          new MissingExternalPinError({
            fragmentId: fragment.id,
            upstream: fragment.source.upstream,
            message: `External fragment ${fragment.id} references missing pin ${fragment.source.upstream}`,
          }),
        )
      }
      if (actualPin.original !== fragment.source.upstream) {
        return Result.fail(
          new ExternalAuthorityMismatchError({
            fragmentId: fragment.id,
            upstream: fragment.source.upstream,
            originalLocator: actualPin.original,
            message: `External fragment ${fragment.id} declares authority ${fragment.source.upstream}, but the resolved pin records original locator ${actualPin.original}`,
          }),
        )
      }
      if (
        actualPin.locked !== fragment.source.resolvedUpstream ||
        actualPin.revision !== fragment.source.verifiedAgainst
      ) {
        return Result.fail(
          new StaleExternalPinError({
            fragmentId: fragment.id,
            upstream: fragment.source.upstream,
            verifiedLocator: fragment.source.resolvedUpstream,
            verifiedAgainst: fragment.source.verifiedAgainst,
            actualLocator: actualPin.locked,
            actualRevision: actualPin.revision,
            message: `External fragment ${fragment.id} was verified against ${fragment.source.resolvedUpstream}@${fragment.source.verifiedAgainst}, but ${fragment.source.upstream} resolves to ${actualPin.locked}@${actualPin.revision}`,
          }),
        )
      }
    }

    for (const tag of fragment.tags) {
      const canonical = canonicalTagIdentity(tag)
      const claims: ReadonlyArray<TagIdentity> = [
        canonical,
        ...tag.aliases.map((alias): TagIdentity => ({ _tag: 'exact', key: alias.key })),
      ]

      for (const identity of claims) {
        if (identity._tag === 'exact') {
          const existingOwner = exactTagOwners.get(identity.key)
          if (existingOwner !== undefined) {
            const formattedIdentity = formatTagIdentity(identity)
            return Result.fail(
              new TagCollisionError({
                identity: formattedIdentity,
                firstFragmentId: existingOwner.fragmentId,
                secondFragmentId: fragment.id,
                message: `Tag identity ${formattedIdentity} collides between ${existingOwner.fragmentId} and ${fragment.id}`,
              }),
            )
          }

          const overlappingPattern = patternTagClaims.find((claim) =>
            patternMatchesExact({ pattern: claim.identity.pattern, key: identity.key }),
          )
          if (overlappingPattern !== undefined) {
            return Result.fail(
              new PatternOverlapError({
                firstIdentity: formatTagIdentity(overlappingPattern.identity),
                secondIdentity: formatTagIdentity(identity),
                firstFragmentId: overlappingPattern.fragmentId,
                secondFragmentId: fragment.id,
                message: `${formatTagIdentity(overlappingPattern.identity)} overlaps ${formatTagIdentity(identity)} between ${overlappingPattern.fragmentId} and ${fragment.id}`,
              }),
            )
          }

          exactTagOwners.set(identity.key, { identity, fragmentId: fragment.id })
          continue
        }

        const overlappingExact = [...exactTagOwners.values()].find(
          (claim) =>
            claim.identity._tag === 'exact' &&
            patternMatchesExact({ pattern: identity.pattern, key: claim.identity.key }),
        )
        if (overlappingExact !== undefined) {
          return Result.fail(
            new PatternOverlapError({
              firstIdentity: formatTagIdentity(overlappingExact.identity),
              secondIdentity: formatTagIdentity(identity),
              firstFragmentId: overlappingExact.fragmentId,
              secondFragmentId: fragment.id,
              message: `${formatTagIdentity(overlappingExact.identity)} overlaps ${formatTagIdentity(identity)} between ${overlappingExact.fragmentId} and ${fragment.id}`,
            }),
          )
        }

        const overlappingPattern = patternTagClaims.find((claim) =>
          patternsOverlap({ left: claim.identity.pattern, right: identity.pattern }),
        )
        if (overlappingPattern !== undefined) {
          return Result.fail(
            new PatternOverlapError({
              firstIdentity: formatTagIdentity(overlappingPattern.identity),
              secondIdentity: formatTagIdentity(identity),
              firstFragmentId: overlappingPattern.fragmentId,
              secondFragmentId: fragment.id,
              message: `${formatTagIdentity(overlappingPattern.identity)} overlaps ${formatTagIdentity(identity)} between ${overlappingPattern.fragmentId} and ${fragment.id}`,
            }),
          )
        }

        patternTagClaims.push({ identity, fragmentId: fragment.id })
      }
    }

    for (const derivation of fragment.derivations) {
      const compatibilityError = validateContractCompatibility({
        definitionKind: 'derivation',
        definition: derivation,
      })
      if (compatibilityError !== undefined) return Result.fail(compatibilityError)
      const existingOwner = derivationOwners.get(derivation.id)
      if (existingOwner !== undefined) {
        return Result.fail(
          new DerivationCollisionError({
            derivationId: derivation.id,
            firstFragmentId: existingOwner,
            secondFragmentId: fragment.id,
            message: `Derivation id ${derivation.id} collides between ${existingOwner} and ${fragment.id}`,
          }),
        )
      }
      derivationOwners.set(derivation.id, fragment.id)
    }

    for (const registered of fragment.registeredValueSchemas) {
      const identity = `${registered.id}@${registered.version}`
      const existingOwner = registeredValueSchemaOwners.get(identity)
      if (existingOwner !== undefined) {
        return Result.fail(
          new RegisteredValueSchemaCollisionError({
            schema: identity,
            firstFragmentId: existingOwner,
            secondFragmentId: fragment.id,
            message: `Registered value schema ${identity} collides between ${existingOwner} and ${fragment.id}`,
          }),
        )
      }
      registeredValueSchemaOwners.set(identity, fragment.id)
    }

    for (const semantic of fragment.adoptedMetadataValues) {
      const existingOwner = adoptedValueOwners.get(semantic.id)
      if (existingOwner !== undefined) {
        return Result.fail(
          new AdoptedValueCollisionError({
            semanticId: semantic.id,
            firstFragmentId: existingOwner,
            secondFragmentId: fragment.id,
            message: `Adopted metadata value id ${semantic.id} collides between ${existingOwner} and ${fragment.id}`,
          }),
        )
      }
      adoptedValueOwners.set(semantic.id, fragment.id)
    }

    for (const profile of fragment.profiles) {
      const compatibilityError = validateContractCompatibility({
        definitionKind: 'profile',
        definition: profile,
      })
      if (compatibilityError !== undefined) return Result.fail(compatibilityError)
      const existingOwner = profileOwners.get(profile.id)
      if (existingOwner !== undefined) {
        return Result.fail(
          new ProducerProfileCollisionError({
            profileId: profile.id,
            firstFragmentId: existingOwner,
            secondFragmentId: fragment.id,
            message: `Producer profile id ${profile.id} collides between ${existingOwner} and ${fragment.id}`,
          }),
        )
      }
      profileOwners.set(profile.id, fragment.id)
    }
  }

  const fragments = input.fragments.toSorted((left, right) => compareById({ left, right }))
  const limitationOwners = new Map<string, string>()
  const limitations = fragments
    .flatMap((fragment) =>
      fragment.limitations.map((limitation) => ({
        ...limitation,
        fragmentId: fragment.id,
      })),
    )
    .toSorted((left, right) => compareText({ left: left.id, right: right.id }))
  for (const limitation of limitations) {
    const existingOwner = limitationOwners.get(limitation.id)
    if (existingOwner !== undefined) {
      return Result.fail(
        new DuplicateLimitationIdError({
          limitationId: limitation.id,
          firstFragmentId: existingOwner,
          secondFragmentId: limitation.fragmentId,
          message: `Limitation id ${limitation.id} collides between ${existingOwner} and ${limitation.fragmentId}`,
        }),
      )
    }
    limitationOwners.set(limitation.id, limitation.fragmentId)

    if (limitation.subject._tag === 'metadata-field') {
      const sourceIdentity = `${limitation.subject.field.surface}:${limitation.subject.field.key}`
      if (metadataFieldOwners.has(sourceIdentity)) continue
      return Result.fail(
        new UnknownLimitationSourceError({
          fragmentId: limitation.fragmentId,
          limitationId: limitation.id,
          source: sourceIdentity,
          message: `Limitation ${limitation.id} from ${limitation.fragmentId} references unknown metadata field ${sourceIdentity}`,
        }),
      )
    }
  }
  const extensionNamespaces = fragments
    .flatMap((fragment) => fragment.extensionNamespaces)
    .toSorted((left, right) => compareText({ left: left.prefix, right: right.prefix }))
  const metadataSurfaces = fragments
    .flatMap((fragment) => fragment.metadataSurfaces)
    .toSorted((left, right) => compareText({ left: left.id, right: right.id }))
  const metadataFields = fragments
    .flatMap((fragment) => fragment.metadataFields)
    .toSorted((left, right) =>
      compareText({
        left: `${left.ref.surface}:${left.ref.key}`,
        right: `${right.ref.surface}:${right.ref.key}`,
      }),
    )
  for (const definition of metadataFields) {
    if (!metadataSurfaceOwners.has(definition.ref.surface)) {
      const identity = `${definition.ref.surface}:${definition.ref.key}`
      return Result.fail(
        new UnknownCatalogReferenceError({
          subject: identity,
          referenceKind: 'metadata-surface',
          reference: definition.ref.surface,
          message: `Metadata field ${identity} references undefined surface ${definition.ref.surface}`,
        }),
      )
    }
  }
  const writerAugmentations = fragments
    .flatMap((fragment) =>
      fragment.writerAugmentations.map((augmentation) => ({
        ...augmentation,
        fragmentId: fragment.id,
      })),
    )
    .toSorted((left, right) => {
      const tagOrder = compareText({ left: left.tagKey, right: right.tagKey })
      return tagOrder === 0
        ? compareText({ left: left.fragmentId, right: right.fragmentId })
        : tagOrder
    })
  for (const augmentation of writerAugmentations) {
    if (!exactTagOwners.has(augmentation.tagKey)) {
      return Result.fail(
        new UnknownWriterAugmentationTargetError({
          fragmentId: augmentation.fragmentId,
          tagKey: augmentation.tagKey,
          message: `Writer augmentation from ${augmentation.fragmentId} references unknown exact tag ${augmentation.tagKey}`,
        }),
      )
    }
  }
  // Cross-owner augmentations are documentation only in schema v2. They are
  // deliberately not merged into the effective writer set and cannot grant
  // constructor or mediated authority.
  const tags = fragments
    .flatMap((fragment) => fragment.tags)
    .toSorted((left, right) => compareTagDefinitions({ left, right }))
  const profiles = fragments
    .flatMap((fragment) => fragment.profiles)
    .toSorted((left, right) => compareText({ left: left.id, right: right.id }))
  const registeredValueSchemas = fragments
    .flatMap((fragment) => fragment.registeredValueSchemas)
    .toSorted((left, right) =>
      compareText({
        left: `${left.id}@${left.version}`,
        right: `${right.id}@${right.version}`,
      }),
    )
  const adoptedMetadataValues = fragments
    .flatMap((fragment) => fragment.adoptedMetadataValues)
    .toSorted((left, right) => compareText({ left: left.id, right: right.id }))

  const metadataFieldByIdentity = new Map(
    metadataFields.map((definition) => [
      `${definition.ref.surface}:${definition.ref.key}`,
      definition,
    ]),
  )
  const registeredSchemaByIdentity = new Map(
    registeredValueSchemas.map((definition) => [
      `${definition.id}@${definition.version}`,
      definition,
    ]),
  )
  const adoptedValueById = new Map(adoptedMetadataValues.map((semantic) => [semantic.id, semantic]))
  const tagValueByIdentity = new Map(
    tags.map((tag) => [
      `pty.tag:${tag._tag === 'exact' ? tag.key : formatTagPattern(tag.pattern)}`,
      tag.value,
    ]),
  )
  for (const tag of tags) {
    const identity = `${tag.authoritativeSource.surface}:${tag.authoritativeSource.key}`
    if (!metadataFieldByIdentity.has(identity)) {
      const tagIdentity = tag._tag === 'exact' ? tag.key : formatTagPattern(tag.pattern)
      return Result.fail(
        new UnknownCatalogReferenceError({
          subject: `pty.tag:${tagIdentity}`,
          referenceKind: 'metadata-field',
          reference: identity,
          message: `Tag ${tagIdentity} references unknown authoritative source ${identity}`,
        }),
      )
    }
  }
  for (const semantic of adoptedMetadataValues) {
    const fieldIdentity = `${semantic.field.surface}:${semantic.field.key}`
    const definition = metadataFieldByIdentity.get(fieldIdentity)
    if (definition === undefined) {
      return Result.fail(
        new UnknownCatalogReferenceError({
          subject: semantic.id,
          referenceKind: 'metadata-field',
          reference: fieldIdentity,
          message: `Adopted value ${semantic.id} references unknown metadata field ${fieldIdentity}`,
        }),
      )
    }
    if (semantic.match._tag === 'fixed') {
      if (!fixedValueAccepted({ schema: definition.value, literal: semantic.match.value })) {
        return Result.fail(
          new MetadataValueDomainMismatchError({
            subject: semantic.id,
            field: fieldIdentity,
            message: `Adopted value ${semantic.id} does not match the ${fieldDomain(definition.value)} domain of ${fieldIdentity}`,
          }),
        )
      }
    } else {
      const schemaIdentity = `${semantic.match.schema.id}@${semantic.match.schema.version}`
      const registered = registeredSchemaByIdentity.get(schemaIdentity)
      if (registered === undefined) {
        return Result.fail(
          new UnknownCatalogReferenceError({
            subject: semantic.id,
            referenceKind: 'registered-value-schema',
            reference: schemaIdentity,
            message: `Adopted value ${semantic.id} references unknown registered value schema ${schemaIdentity}`,
          }),
        )
      }
      if (registered.input !== fieldDomain(definition.value)) {
        return Result.fail(
          new MetadataValueDomainMismatchError({
            subject: semantic.id,
            field: fieldIdentity,
            message: `Registered schema ${schemaIdentity} accepts ${registered.input}, not the ${fieldDomain(definition.value)} domain of ${fieldIdentity}`,
          }),
        )
      }
    }
  }
  for (let leftIndex = 0; leftIndex < adoptedMetadataValues.length; leftIndex += 1) {
    const left = adoptedMetadataValues[leftIndex]
    if (left === undefined) continue
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < adoptedMetadataValues.length;
      rightIndex += 1
    ) {
      const right = adoptedMetadataValues[rightIndex]
      if (right === undefined) continue
      const sameField =
        left.field.surface === right.field.surface && left.field.key === right.field.key
      const phasesOverlap = left.phases.some((phase) => right.phases.includes(phase))
      if (!sameField || left.consumer !== right.consumer || !phasesOverlap) continue
      const leftMatch = matchIdentity(left)
      const rightMatch = matchIdentity(right)
      if (left.match._tag === 'fixed' && right.match._tag === 'fixed') {
        if (leftMatch !== rightMatch) continue
        return Result.fail(
          new AdoptedValueOverlapError({
            firstSemanticId: left.id,
            secondSemanticId: right.id,
            identity: `${left.field.surface}:${left.field.key}:${left.consumer}:${leftMatch}`,
            message: `Adopted values ${left.id} and ${right.id} overlap for ${left.consumer}`,
          }),
        )
      }
      if (leftMatch === rightMatch) {
        return Result.fail(
          new AdoptedValueOverlapError({
            firstSemanticId: left.id,
            secondSemanticId: right.id,
            identity: `${left.field.surface}:${left.field.key}:${left.consumer}:${leftMatch}`,
            message: `Adopted values ${left.id} and ${right.id} overlap for ${left.consumer}`,
          }),
        )
      }
      return Result.fail(
        new AdoptedValueIntersectionIndeterminateError({
          firstSemanticId: left.id,
          secondSemanticId: right.id,
          field: `${left.field.surface}:${left.field.key}`,
          consumer: left.consumer,
          message: `Adopted value intersection between ${left.id} and ${right.id} is indeterminate without executable schema evidence`,
        }),
      )
    }
  }

  for (const profile of profiles) {
    if (profile.selector._tag !== 'declared-producer') {
      const selectorIdentity = `${profile.selector.field.surface}:${profile.selector.field.key}`
      const selectorDefinition = metadataFieldByIdentity.get(selectorIdentity)
      if (selectorDefinition === undefined) {
        return Result.fail(
          new UnknownCatalogReferenceError({
            subject: profile.id,
            referenceKind: 'metadata-field',
            reference: selectorIdentity,
            message: `Profile ${profile.id} selector references unknown metadata field ${selectorIdentity}`,
          }),
        )
      }
      if (
        profile.selector._tag === 'metadata-field' &&
        profile.selector.equals !== undefined &&
        !fixedValueAccepted({
          schema: selectorDefinition.value,
          literal: profile.selector.equals,
        })
      ) {
        return Result.fail(
          new ProfileSelectorDomainMismatchError({
            profileId: profile.id,
            field: selectorIdentity,
            value: profile.selector.equals,
            expectedDomain: fieldDomain(selectorDefinition.value),
            message: `Profile ${profile.id} selector value does not match the ${fieldDomain(selectorDefinition.value)} domain of ${selectorIdentity}`,
          }),
        )
      }
    }
    const constraintTargets = new Set<string>()
    for (const constraint of profile.constraints) {
      const targetIdentity = formatFieldIdentity(constraint.target)
      if (constraintTargets.has(targetIdentity)) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'duplicate-target',
            message: `Profile ${profile.id} declares target ${targetIdentity} more than once`,
          }),
        )
      }
      constraintTargets.add(targetIdentity)
      const targetValue =
        metadataFieldByIdentity.get(targetIdentity)?.value ?? tagValueByIdentity.get(targetIdentity)
      if (targetValue === undefined) {
        return Result.fail(
          new UnknownCatalogReferenceError({
            subject: profile.id,
            referenceKind: 'metadata-field',
            reference: targetIdentity,
            message: `Profile ${profile.id} constraint references unknown field identity ${targetIdentity}`,
          }),
        )
      }
      if (constraint.presence === 'forbidden' && constraint.value !== undefined) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'forbidden-with-value',
            message: `Profile ${profile.id} cannot assign a value constraint to forbidden target ${targetIdentity}`,
          }),
        )
      }
      if (
        constraint.occurrences?.maximum !== undefined &&
        constraint.occurrences.minimum > constraint.occurrences.maximum
      ) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'invalid-occurrence-range',
            message: `Profile ${profile.id} has an inverted occurrence range for ${targetIdentity}`,
          }),
        )
      }
      if (constraint.presence === 'required' && constraint.occurrences?.maximum === 0) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'required-with-zero-maximum',
            message: `Required target ${targetIdentity} cannot have maximum zero occurrences`,
          }),
        )
      }
      if (constraint.presence === 'required' && (constraint.occurrences?.minimum ?? 1) < 1) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'required-with-zero-minimum',
            message: `Required target ${targetIdentity} must have an occurrence minimum of at least one`,
          }),
        )
      }
      if (constraint.presence === 'optional' && (constraint.occurrences?.minimum ?? 0) > 0) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'optional-with-positive-minimum',
            message: `Optional target ${targetIdentity} cannot require a positive occurrence minimum`,
          }),
        )
      }
      if (
        constraint.presence === 'forbidden' &&
        constraint.occurrences !== undefined &&
        (constraint.occurrences.minimum !== 0 || constraint.occurrences.maximum !== 0)
      ) {
        return Result.fail(
          new InvalidProfileConstraintError({
            profileId: profile.id,
            target: targetIdentity,
            reason: 'forbidden-with-nonzero-occurrences',
            message: `Forbidden target ${targetIdentity} must have an exact zero occurrence range`,
          }),
        )
      }
      if (constraint.when !== undefined) {
        const predicateIdentity = `${constraint.when.field.surface}:${constraint.when.field.key}`
        const predicateDefinition = metadataFieldByIdentity.get(predicateIdentity)
        if (predicateDefinition === undefined) {
          return Result.fail(
            new UnknownCatalogReferenceError({
              subject: profile.id,
              referenceKind: 'metadata-field',
              reference: predicateIdentity,
              message: `Profile ${profile.id} condition references unknown metadata field ${predicateIdentity}`,
            }),
          )
        }
        if (
          constraint.when._tag === 'equals' &&
          !fixedValueAccepted({
            schema: predicateDefinition.value,
            literal: constraint.when.value,
          })
        ) {
          return Result.fail(
            new MetadataValueDomainMismatchError({
              subject: profile.id,
              field: predicateIdentity,
              message: `Profile ${profile.id} condition value does not match the ${fieldDomain(predicateDefinition.value)} domain of ${predicateIdentity}`,
            }),
          )
        }
      }
      if (
        constraint.value?._tag === 'fixed' &&
        !fixedValueAccepted({ schema: targetValue, literal: constraint.value.value })
      ) {
        return Result.fail(
          new MetadataValueDomainMismatchError({
            subject: profile.id,
            field: targetIdentity,
            message: `Profile ${profile.id} fixed value does not match the ${fieldDomain(targetValue)} domain of ${targetIdentity}`,
          }),
        )
      }
      if (constraint.value?._tag === 'registered-schema') {
        const schemaIdentity = `${constraint.value.schema.id}@${constraint.value.schema.version}`
        const registered = registeredSchemaByIdentity.get(schemaIdentity)
        if (registered === undefined) {
          return Result.fail(
            new UnknownCatalogReferenceError({
              subject: profile.id,
              referenceKind: 'registered-value-schema',
              reference: schemaIdentity,
              message: `Profile ${profile.id} references unknown registered value schema ${schemaIdentity}`,
            }),
          )
        }
        if (registered.input !== fieldDomain(targetValue)) {
          return Result.fail(
            new MetadataValueDomainMismatchError({
              subject: profile.id,
              field: targetIdentity,
              message: `Profile ${profile.id} schema ${schemaIdentity} does not match the field domain`,
            }),
          )
        }
      }
      if (constraint.value?._tag === 'adopted-value') {
        const semantic = adoptedValueById.get(constraint.value.semanticId)
        if (semantic === undefined) {
          return Result.fail(
            new UnknownCatalogReferenceError({
              subject: profile.id,
              referenceKind: 'adopted-value',
              reference: constraint.value.semanticId,
              message: `Profile ${profile.id} references unknown adopted value ${constraint.value.semanticId}`,
            }),
          )
        }
        if (`${semantic.field.surface}:${semantic.field.key}` !== targetIdentity) {
          return Result.fail(
            new MetadataValueDomainMismatchError({
              subject: profile.id,
              field: targetIdentity,
              message: `Adopted value ${semantic.id} belongs to a different metadata field`,
            }),
          )
        }
      }
    }
  }

  const normalizedConstraintValue = (
    constraint: (typeof profiles)[number]['constraints'][number],
  ): { readonly kind: 'fixed' | 'schema'; readonly identity: string } | undefined => {
    if (constraint.value === undefined) return undefined
    if (constraint.value._tag === 'fixed') {
      return { kind: 'fixed', identity: literalIdentity(constraint.value.value) }
    }
    if (constraint.value._tag === 'registered-schema') {
      return {
        kind: 'schema',
        identity: `${constraint.value.schema.id}@${constraint.value.schema.version}`,
      }
    }
    const semantic = adoptedValueById.get(constraint.value.semanticId)
    if (semantic === undefined) return undefined
    return semantic.match._tag === 'fixed'
      ? { kind: 'fixed', identity: literalIdentity(semantic.match.value) }
      : {
          kind: 'schema',
          identity: `${semantic.match.schema.id}@${semantic.match.schema.version}`,
        }
  }
  const constraintsConflict = (args: {
    readonly left: (typeof profiles)[number]['constraints'][number]
    readonly right: (typeof profiles)[number]['constraints'][number]
  }) => {
    if (predicatesAreDisjoint({ left: args.left.when, right: args.right.when })) return undefined
    const leftInterval = occurrenceInterval(args.left)
    const rightInterval = occurrenceInterval(args.right)
    const minimum = Math.max(leftInterval.minimum, rightInterval.minimum)
    const intervalsOverlap = minimum <= Math.min(leftInterval.maximum, rightInterval.maximum)
    if (!intervalsOverlap) return 'disjoint-occurrence-ranges'
    const leftValue = normalizedConstraintValue(args.left)
    const rightValue = normalizedConstraintValue(args.right)
    if (minimum < 1 || leftValue === undefined || rightValue === undefined) return undefined
    if (leftValue.kind === 'fixed' && rightValue.kind === 'fixed') {
      return leftValue.identity === rightValue.identity ? undefined : 'conflicting-values'
    }
    if (leftValue.kind === 'schema' && rightValue.kind === 'schema') {
      return leftValue.identity === rightValue.identity
        ? undefined
        : 'value-intersection-indeterminate'
    }
    return 'value-intersection-indeterminate'
  }
  for (const profile of profiles) {
    const implicit = implicitSelectorConstraint(profile.selector)
    if (implicit === undefined) continue
    const target = formatFieldIdentity(implicit.target)
    const explicit = profile.constraints.find(
      (constraint) => formatFieldIdentity(constraint.target) === target,
    )
    const reason =
      explicit === undefined ? undefined : constraintsConflict({ left: implicit, right: explicit })
    if (reason !== undefined) {
      return Result.fail(
        new InvalidProfileConstraintError({
          profileId: profile.id,
          target,
          reason: `selector-${reason}`,
          message: `Profile ${profile.id} constraint conflicts with its selector on ${target}: ${reason}`,
        }),
      )
    }
  }
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    const left = profiles[leftIndex]
    if (left === undefined) continue
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const right = profiles[rightIndex]
      if (
        right === undefined ||
        !selectorsMayOverlap({ left: left.selector, right: right.selector })
      )
        continue
      for (const leftConstraint of profileRequirements(left)) {
        const target = formatFieldIdentity(leftConstraint.target)
        const rightConstraint = profileRequirements(right).find(
          (candidate) => formatFieldIdentity(candidate.target) === target,
        )
        if (rightConstraint === undefined) continue
        const reason = constraintsConflict({ left: leftConstraint, right: rightConstraint })
        if (reason !== undefined) {
          return Result.fail(
            new IncompatibleProducerProfilesError({
              firstProfileId: left.id,
              firstFragmentId: profileOwners.get(left.id) ?? 'unknown',
              secondProfileId: right.id,
              secondFragmentId: profileOwners.get(right.id) ?? 'unknown',
              target,
              reason,
              message: `Co-applicable profiles ${left.id} and ${right.id} conflict on ${target}: ${reason}`,
            }),
          )
        }
      }
    }
  }
  const aliases: ReadonlyArray<ResolvedAliasDefinition> = tags
    .flatMap((tag) => {
      const canonical = canonicalTagIdentity(tag)
      return tag.aliases.map((alias) => ({ ...alias, canonical }))
    })
    .toSorted((left, right) => {
      const keyOrder = compareText({ left: left.key, right: right.key })
      return keyOrder === 0
        ? compareText({
            left: formatTagIdentity(left.canonical),
            right: formatTagIdentity(right.canonical),
          })
        : keyOrder
    })
  const derivations = fragments
    .flatMap((fragment) => fragment.derivations)
    .toSorted((left, right) => compareText({ left: left.id, right: right.id }))
  for (const derivation of derivations) {
    if (derivation.transform._tag === 'keyed-map') {
      if (!metadataSurfaceOwners.has(derivation.transform.targetSurface)) {
        return Result.fail(
          new UnknownCatalogReferenceError({
            subject: derivation.id,
            referenceKind: 'metadata-surface',
            reference: derivation.transform.targetSurface,
            message: `Keyed-map derivation ${derivation.id} references unknown dynamic target surface ${derivation.transform.targetSurface}`,
          }),
        )
      }
      const variableNames = derivation.transform.variables.map(({ name }) => name)
      if (new Set(variableNames).size !== variableNames.length) {
        return Result.fail(
          new InvalidDerivationShapeError({
            derivationId: derivation.id,
            reason: 'keyed-map-duplicate-variable',
            message: `Keyed-map derivation ${derivation.id} declares a launch-context variable more than once`,
          }),
        )
      }
      if (derivation.target !== undefined) {
        return Result.fail(
          new InvalidDerivationShapeError({
            derivationId: derivation.id,
            reason: 'keyed-map-has-static-target',
            message: `Keyed-map derivation ${derivation.id} must carry its dynamic target surface in the transform rather than a static target`,
          }),
        )
      }
      if (derivation.lossiness !== 'transformed') {
        return Result.fail(
          new InvalidDerivationShapeError({
            derivationId: derivation.id,
            reason: 'keyed-map-not-transformed',
            message: `Keyed-map derivation ${derivation.id} must declare transformed lossiness`,
          }),
        )
      }
      if (derivation.phases.join(',') !== 'create,launch') {
        return Result.fail(
          new InvalidDerivationShapeError({
            derivationId: derivation.id,
            reason: 'keyed-map-invalid-phases',
            message: `Keyed-map derivation ${derivation.id} must run at create and launch only`,
          }),
        )
      }
    } else {
      const isTerminal = derivation.lossiness === 'terminal'
      if ((derivation.target === undefined) !== isTerminal) {
        return Result.fail(
          new InvalidDerivationShapeError({
            derivationId: derivation.id,
            reason: isTerminal ? 'terminal-has-target' : 'non-terminal-missing-target',
            message: `Static derivation ${derivation.id} must omit target exactly when its lossiness is terminal`,
          }),
        )
      }
    }
    const references = [
      ...derivation.source,
      ...(derivation.target === undefined ? [] : [derivation.target]),
      ...derivation.when.map(({ field }) => field),
    ]
    for (const reference of references) {
      const identity = `${reference.surface}:${reference.key}`
      if (!metadataFieldByIdentity.has(identity)) {
        return Result.fail(
          new UnknownCatalogReferenceError({
            subject: derivation.id,
            referenceKind: 'metadata-field',
            reference: identity,
            message: `Derivation ${derivation.id} references unknown metadata field ${identity}`,
          }),
        )
      }
    }
    for (const predicate of derivation.when) {
      if (predicate._tag !== 'equals') continue
      const identity = `${predicate.field.surface}:${predicate.field.key}`
      const definition = metadataFieldByIdentity.get(identity)
      if (
        definition !== undefined &&
        !fixedValueAccepted({ schema: definition.value, literal: predicate.value })
      ) {
        return Result.fail(
          new MetadataValueDomainMismatchError({
            subject: derivation.id,
            field: identity,
            message: `Derivation ${derivation.id} predicate value does not match the ${fieldDomain(definition.value)} domain of ${identity}`,
          }),
        )
      }
    }
  }

  const externalPins = Object.fromEntries(
    Object.entries(input.externalPins).toSorted(([left], [right]) => compareText({ left, right })),
  )

  return Result.succeed({
    schemaVersion: input.schemaVersion,
    externalPins,
    fragments,
    namespaceAuthorities: resolvedNamespaceAuthorities.toSorted((left, right) =>
      compareText({ left: left.namespace, right: right.namespace }),
    ),
    extensionNamespaces,
    metadataSurfaces,
    metadataFields,
    tags,
    writerAugmentations,
    registeredValueSchemas,
    adoptedMetadataValues,
    limitations,
    profiles,
    aliases,
    derivations,
  })
}
