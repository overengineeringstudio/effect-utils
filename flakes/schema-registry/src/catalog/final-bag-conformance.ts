import { Effect, Schema } from 'effect'

import { patternMatchesExact } from './compose.ts'
import {
  assertDeclaredProducerProfilesConform,
  type ExactMetadataMultimap,
  type ProfileConformanceError,
} from './profile-conformance.ts'
import type { RuntimeValueSchemaRegistry } from './runtime-value-schema.ts'
import type { ResolvedCatalog, TagDefinition, TagValueSchema } from './schema.ts'

class UnknownManagedPtyTagError extends Schema.TaggedError<UnknownManagedPtyTagError>()(
  'UnknownManagedPtyTagError',
  {
    key: Schema.NonEmptyString.check(Schema.isTrimmed()),
    message: Schema.NonEmptyString.check(Schema.isTrimmed()),
  },
) {}

class ManagedPtyTagValueError extends Schema.TaggedError<ManagedPtyTagValueError>()(
  'ManagedPtyTagValueError',
  {
    key: Schema.NonEmptyString.check(Schema.isTrimmed()),
    occurrence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    expected: Schema.NonEmptyString.check(Schema.isTrimmed()),
    actualType: Schema.NonEmptyString.check(Schema.isTrimmed()),
    message: Schema.NonEmptyString.check(Schema.isTrimmed()),
  },
) {}

type ManagedFinalBagConformanceError =
  | UnknownManagedPtyTagError
  | ManagedPtyTagValueError
  | ProfileConformanceError

const canonicalDefinition = (args: {
  readonly catalog: ResolvedCatalog
  readonly key: string
}): TagDefinition | undefined => {
  // Managed writes are canonical-only. Aliases remain documented reader
  // compatibility and are deliberately rejected by this admission boundary.
  return args.catalog.tags.find((tag) =>
    tag._tag === 'exact'
      ? tag.key === args.key
      : patternMatchesExact({ pattern: tag.pattern, key: args.key }),
  )
}

const valueExpectation = (value: TagValueSchema): string => {
  switch (value._tag) {
    case 'string':
      return value.nonEmpty === true ? 'a non-empty string' : 'a string'
    case 'boolean-string':
      return 'true or false'
    case 'integer-string':
      return `a base-10 integer${value.minimum === undefined ? '' : ` >= ${value.minimum}`}${value.maximum === undefined ? '' : ` <= ${value.maximum}`}`
    case 'timestamp':
      return 'an RFC 3339 timestamp'
    case 'identifier':
      return `a non-empty ${value.brand} identifier`
    case 'enum':
      return `one of ${value.values.join(', ')}`
    case 'url':
      return 'an absolute URL'
    case 'structured-string':
      return `${value.schemaId}@${value.version}`
  }
}

const isValidValue = (args: {
  readonly value: TagValueSchema
  readonly actual: unknown
}): boolean => {
  if (typeof args.actual !== 'string') return false
  switch (args.value._tag) {
    case 'string':
      return args.value.nonEmpty !== true || args.actual.length > 0
    case 'boolean-string':
      return args.actual === 'true' || args.actual === 'false'
    case 'integer-string': {
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(args.actual)) return false
      const parsed = Number(args.actual)
      return (
        Number.isSafeInteger(parsed) &&
        (args.value.minimum === undefined || parsed >= args.value.minimum) &&
        (args.value.maximum === undefined || parsed <= args.value.maximum)
      )
    }
    case 'timestamp':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(args.actual)
    case 'identifier':
      return args.actual.length > 0
    case 'enum':
      return args.value.values.includes(args.actual)
    case 'url': {
      try {
        return new URL(args.actual).protocol.length > 1
      } catch {
        return false
      }
    }
    case 'structured-string':
      // Registered structured-string validators are exercised by profiles. At
      // the catalog-wide boundary the wire domain is still a string.
      return true
  }
}

const actualType = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/**
 * Validates every observed PTY tag in a managed bag against the closed catalog.
 * External/unmanaged sessions must not call this boundary: preserving their
 * opaque tag map is an explicit compatibility regime, not a validation bypass.
 */
export const assertManagedPtyTagBagConforms = (args: {
  readonly catalog: ResolvedCatalog
  readonly metadata: ExactMetadataMultimap
}): Effect.Effect<void, UnknownManagedPtyTagError | ManagedPtyTagValueError> =>
  Effect.gen(function* () {
    for (const [identity, values] of args.metadata) {
      if (!identity.startsWith('pty.tag:')) continue
      const key = identity.slice('pty.tag:'.length)
      const definition = canonicalDefinition({ catalog: args.catalog, key })
      if (definition === undefined) {
        return yield* new UnknownManagedPtyTagError({
          key,
          message: `Managed PTY tag ${key} is not declared by the composed catalog`,
        })
      }
      for (const [occurrence, actual] of values.entries()) {
        if (!isValidValue({ value: definition.value, actual })) {
          const expected = valueExpectation(definition.value)
          return yield* new ManagedPtyTagValueError({
            key,
            occurrence,
            expected,
            actualType: actualType(actual),
            message: `Managed PTY tag ${key} occurrence ${occurrence} must be ${expected}`,
          })
        }
      }
    }
  })

/** Validates one final managed metadata bag against all independently declared producers. */
export const assertManagedFinalBagConforms = (args: {
  readonly catalog: ResolvedCatalog
  readonly runtimeRegistry: RuntimeValueSchemaRegistry
  readonly declaredProducers: ReadonlyArray<string>
  readonly metadata: ExactMetadataMultimap
}): Effect.Effect<ReadonlyArray<string>, ManagedFinalBagConformanceError> =>
  assertManagedPtyTagBagConforms(args).pipe(
    Effect.andThen(
      assertDeclaredProducerProfilesConform({
        catalog: args.catalog,
        runtimeRegistry: args.runtimeRegistry,
        declaredProducers: args.declaredProducers,
        metadata: args.metadata,
      }),
    ),
  )
