import { Effect, Schema } from 'effect'

import {
  assertRegisteredValueConforms,
  type RuntimeValueSchemaRegistry,
} from './runtime-value-schema.ts'
import type { MetadataFieldReference, ResolvedCatalog } from './schema.ts'

/** Occurrence-preserving values keyed by exact `surface:key` identity for final-bag checks. */
export type ExactMetadataMultimap = ReadonlyMap<string, ReadonlyArray<unknown>>

class UnknownDeclaredProducerProfileError extends Schema.TaggedError<UnknownDeclaredProducerProfileError>()(
  'UnknownDeclaredProducerProfileError',
  {
    declaredProducer: Schema.String,
    message: Schema.String,
  },
) {}

class AmbiguousDeclaredProducerProfileError extends Schema.TaggedError<AmbiguousDeclaredProducerProfileError>()(
  'AmbiguousDeclaredProducerProfileError',
  {
    declaredProducer: Schema.String,
    profileIds: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

class UnsupportedProfileConformanceError extends Schema.TaggedError<UnsupportedProfileConformanceError>()(
  'UnsupportedProfileConformanceError',
  {
    profileId: Schema.String,
    constraintIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    feature: Schema.Literals(['pattern-target', 'conditional-constraint']),
    message: Schema.String,
  },
) {}

class ProfileConstraintConformanceError extends Schema.TaggedError<ProfileConstraintConformanceError>()(
  'ProfileConstraintConformanceError',
  {
    profileId: Schema.String,
    constraintIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    field: Schema.String,
    violation: Schema.Literals([
      'required-value-absent',
      'forbidden-value-present',
      'occurrence-range',
      'fixed-value-mismatch',
      'registered-value-mismatch',
      'unknown-adopted-value',
      'adopted-value-target-mismatch',
    ]),
    actualOccurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    message: Schema.String,
  },
) {}

/** Failures proving selection ambiguity, unsupported constraints, or an exact value violation. */
export type ProfileConformanceError =
  | UnknownDeclaredProducerProfileError
  | AmbiguousDeclaredProducerProfileError
  | UnsupportedProfileConformanceError
  | ProfileConstraintConformanceError

/**
 * Applies every independently declared producer profile to the same final bag.
 * Profile order is not semantic; duplicate declarations are collapsed and the
 * returned profile ids are canonicalized for deterministic evidence.
 */
export const assertDeclaredProducerProfilesConform = (args: {
  readonly catalog: ResolvedCatalog
  readonly runtimeRegistry: RuntimeValueSchemaRegistry
  readonly declaredProducers: ReadonlyArray<string>
  readonly metadata: ExactMetadataMultimap
}): Effect.Effect<ReadonlyArray<string>, ProfileConformanceError> =>
  Effect.forEach(
    [...new Set(args.declaredProducers)].toSorted(),
    (declaredProducer) =>
      assertDeclaredProducerProfileConforms({
        catalog: args.catalog,
        runtimeRegistry: args.runtimeRegistry,
        declaredProducer,
        metadata: args.metadata,
      }),
    { concurrency: 1 },
  )

const fieldIdentity = (field: MetadataFieldReference): string => `${field.surface}:${field.key}`

const literalEqual = (args: { readonly left: unknown; readonly right: unknown }): boolean => {
  const { left, right } = args
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  return left === right
}

const constraintFailure = (args: {
  readonly profileId: string
  readonly constraintIndex: number
  readonly field: string
  readonly violation: ProfileConstraintConformanceError['violation']
  readonly actualOccurrences: number
}) =>
  new ProfileConstraintConformanceError({
    profileId: args.profileId,
    constraintIndex: args.constraintIndex,
    field: args.field,
    violation: args.violation,
    actualOccurrences: args.actualOccurrences,
    message: `Observed metadata does not conform to ${args.profileId} at ${args.field}: ${args.violation}`,
  })

/**
 * Conforms an exact metadata multimap to the profile selected exclusively by
 * an independently supplied declared-producer identity. Metadata values never
 * infer or change that producer identity.
 */
export const assertDeclaredProducerProfileConforms = (args: {
  readonly catalog: ResolvedCatalog
  readonly runtimeRegistry: RuntimeValueSchemaRegistry
  readonly declaredProducer: string
  readonly metadata: ExactMetadataMultimap
}): Effect.Effect<string, ProfileConformanceError> =>
  Effect.gen(function* () {
    const candidates = args.catalog.profiles.filter(
      (profile) =>
        profile.selector._tag === 'declared-producer' &&
        profile.selector.producer === args.declaredProducer,
    )
    if (candidates.length === 0) {
      return yield* new UnknownDeclaredProducerProfileError({
        declaredProducer: args.declaredProducer,
        message: `No producer profile is registered for declared producer ${args.declaredProducer}`,
      })
    }
    if (candidates.length > 1) {
      return yield* new AmbiguousDeclaredProducerProfileError({
        declaredProducer: args.declaredProducer,
        profileIds: candidates.map(({ id }) => id).toSorted(),
        message: `Declared producer ${args.declaredProducer} selects more than one profile`,
      })
    }
    const profile = candidates[0]
    if (profile === undefined) {
      return yield* new UnknownDeclaredProducerProfileError({
        declaredProducer: args.declaredProducer,
        message: `No producer profile is registered for declared producer ${args.declaredProducer}`,
      })
    }

    for (const [constraintIndex, constraint] of profile.constraints.entries()) {
      if (constraint.target._tag === 'pattern') {
        return yield* new UnsupportedProfileConformanceError({
          profileId: profile.id,
          constraintIndex,
          feature: 'pattern-target',
          message: `Executable conformance for ${profile.id} does not support pattern targets`,
        })
      }
      if (constraint.when !== undefined) {
        return yield* new UnsupportedProfileConformanceError({
          profileId: profile.id,
          constraintIndex,
          feature: 'conditional-constraint',
          message: `Executable conformance for ${profile.id} does not support conditional constraints`,
        })
      }

      const identity = fieldIdentity(constraint.target.field)
      const values = args.metadata.get(identity) ?? []
      const occurrences = values.length
      if (constraint.presence === 'required' && occurrences === 0) {
        return yield* constraintFailure({
          profileId: profile.id,
          constraintIndex,
          field: identity,
          violation: 'required-value-absent',
          actualOccurrences: occurrences,
        })
      }
      if (constraint.presence === 'forbidden' && occurrences !== 0) {
        return yield* constraintFailure({
          profileId: profile.id,
          constraintIndex,
          field: identity,
          violation: 'forbidden-value-present',
          actualOccurrences: occurrences,
        })
      }
      if (
        constraint.occurrences !== undefined &&
        (occurrences < constraint.occurrences.minimum ||
          (constraint.occurrences.maximum !== undefined &&
            occurrences > constraint.occurrences.maximum))
      ) {
        return yield* constraintFailure({
          profileId: profile.id,
          constraintIndex,
          field: identity,
          violation: 'occurrence-range',
          actualOccurrences: occurrences,
        })
      }
      if (constraint.value === undefined || occurrences === 0) continue

      let match = constraint.value
      if (match._tag === 'adopted-value') {
        const semanticId = match.semanticId
        const adopted = args.catalog.adoptedMetadataValues.find(({ id }) => id === semanticId)
        if (adopted === undefined) {
          return yield* constraintFailure({
            profileId: profile.id,
            constraintIndex,
            field: identity,
            violation: 'unknown-adopted-value',
            actualOccurrences: occurrences,
          })
        }
        if (fieldIdentity(adopted.field) !== identity) {
          return yield* constraintFailure({
            profileId: profile.id,
            constraintIndex,
            field: identity,
            violation: 'adopted-value-target-mismatch',
            actualOccurrences: occurrences,
          })
        }
        match = adopted.match
      }

      if (match._tag === 'fixed') {
        if (!values.every((value) => literalEqual({ left: value, right: match.value }))) {
          return yield* constraintFailure({
            profileId: profile.id,
            constraintIndex,
            field: identity,
            violation: 'fixed-value-mismatch',
            actualOccurrences: occurrences,
          })
        }
      } else {
        for (const value of values) {
          const checked = yield* Effect.result(
            assertRegisteredValueConforms({
              registry: args.runtimeRegistry,
              reference: match.schema,
              value,
            }),
          )
          if (checked._tag === 'Failure') {
            return yield* constraintFailure({
              profileId: profile.id,
              constraintIndex,
              field: identity,
              violation: 'registered-value-mismatch',
              actualOccurrences: occurrences,
            })
          }
        }
      }
    }
    return profile.id
  })
