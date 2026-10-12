import { Effect, Schema } from 'effect'

import type { RegisteredValueSchemaDefinition, RegisteredValueSchemaReference } from './schema.ts'

const runtimeRegisteredValueSchemaBrand: unique symbol = Symbol(
  'PtyTagSchema.RuntimeRegisteredValueSchema',
)

/** Branded pairing of a neutral definition with its non-serializable executable Effect Schema. */
export type RuntimeRegisteredValueSchema = {
  readonly definition: RegisteredValueSchemaDefinition
  readonly schema: Schema.ConstraintDecoder<unknown, never>
  readonly [runtimeRegisteredValueSchemaBrand]: true
}

/** Constructs the branded runtime pair while restricting the neutral input domain to strings. */
export const defineStringRuntimeValueSchema = (entry: {
  readonly definition: RegisteredValueSchemaDefinition & { readonly input: 'string' }
  readonly schema: Schema.ConstraintDecoder<unknown, never>
}): RuntimeRegisteredValueSchema => ({ ...entry, [runtimeRegisteredValueSchemaBrand]: true })

/** Runtime-only validator lookup keyed by canonical `id@version` schema identity. */
export type RuntimeValueSchemaRegistry = ReadonlyMap<string, RuntimeRegisteredValueSchema>

class RuntimeValueSchemaCollisionError extends Schema.TaggedError<RuntimeValueSchemaCollisionError>()(
  'RuntimeValueSchemaCollisionError',
  {
    schemaId: Schema.String,
    schemaVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    message: Schema.String,
  },
) {}

class RuntimeValueSchemaCoverageError extends Schema.TaggedError<RuntimeValueSchemaCoverageError>()(
  'RuntimeValueSchemaCoverageError',
  {
    schemaId: Schema.String,
    schemaVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    issue: Schema.Literals([
      'missing-runtime-schema',
      'unexpected-runtime-schema',
      'definition-mismatch',
    ]),
    message: Schema.String,
  },
) {}

class UnknownRuntimeValueSchemaError extends Schema.TaggedError<UnknownRuntimeValueSchemaError>()(
  'UnknownRuntimeValueSchemaError',
  {
    schemaId: Schema.String,
    schemaVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    message: Schema.String,
  },
) {}

class RegisteredValueConformanceError extends Schema.TaggedError<RegisteredValueConformanceError>()(
  'RegisteredValueConformanceError',
  {
    schemaId: Schema.String,
    schemaVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    actualType: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

type RuntimeValueSchemaRegistryError =
  | RuntimeValueSchemaCollisionError
  | RuntimeValueSchemaCoverageError

/** Registry construction outcome: the runtime lookup or a collision/coverage failure. */
export type RuntimeValueSchemaRegistryEffect = Effect.Effect<
  RuntimeValueSchemaRegistry,
  RuntimeValueSchemaRegistryError
>

const schemaIdentity = ({ id, version }: RegisteredValueSchemaReference): string =>
  `${id}@${version}`

const definitionIdentity = (definition: RegisteredValueSchemaDefinition): string =>
  schemaIdentity(definition)

const canonicalDefinition = (definition: RegisteredValueSchemaDefinition): string =>
  JSON.stringify({
    id: definition.id,
    version: definition.version,
    input: definition.input,
    description: definition.description,
    semanticOwner: definition.semanticOwner,
  })

const actualType = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/**
 * Pairs the neutral registered-schema definitions with colocated executable
 * Effect Schemas. The returned registry is runtime-only and is never encoded
 * into the neutral catalog DTO.
 */
export const makeRuntimeValueSchemaRegistry = (args: {
  readonly definitions: ReadonlyArray<RegisteredValueSchemaDefinition>
  readonly runtimeSchemas: ReadonlyArray<RuntimeRegisteredValueSchema>
}): RuntimeValueSchemaRegistryEffect =>
  Effect.gen(function* () {
    const runtimeByIdentity = new Map<string, RuntimeRegisteredValueSchema>()
    for (const runtimeSchema of args.runtimeSchemas) {
      const identity = definitionIdentity(runtimeSchema.definition)
      if (runtimeByIdentity.has(identity)) {
        return yield* new RuntimeValueSchemaCollisionError({
          schemaId: runtimeSchema.definition.id,
          schemaVersion: runtimeSchema.definition.version,
          message: `Runtime value schema ${identity} is registered more than once`,
        })
      }
      runtimeByIdentity.set(identity, runtimeSchema)
    }

    const definitionByIdentity = new Map<string, RegisteredValueSchemaDefinition>()
    for (const definition of args.definitions) {
      const identity = definitionIdentity(definition)
      if (definitionByIdentity.has(identity)) {
        return yield* new RuntimeValueSchemaCollisionError({
          schemaId: definition.id,
          schemaVersion: definition.version,
          message: `Neutral value schema definition ${identity} is registered more than once`,
        })
      }
      definitionByIdentity.set(identity, definition)
      const runtimeSchema = runtimeByIdentity.get(identity)
      if (runtimeSchema === undefined) {
        return yield* new RuntimeValueSchemaCoverageError({
          schemaId: definition.id,
          schemaVersion: definition.version,
          issue: 'missing-runtime-schema',
          message: `Neutral definition ${identity} has no executable runtime schema`,
        })
      }
      if (canonicalDefinition(runtimeSchema.definition) !== canonicalDefinition(definition)) {
        return yield* new RuntimeValueSchemaCoverageError({
          schemaId: definition.id,
          schemaVersion: definition.version,
          issue: 'definition-mismatch',
          message: `Runtime value schema ${identity} is not paired with the composed neutral definition`,
        })
      }
    }
    for (const runtimeSchema of args.runtimeSchemas) {
      const identity = definitionIdentity(runtimeSchema.definition)
      if (!definitionByIdentity.has(identity)) {
        return yield* new RuntimeValueSchemaCoverageError({
          schemaId: runtimeSchema.definition.id,
          schemaVersion: runtimeSchema.definition.version,
          issue: 'unexpected-runtime-schema',
          message: `Runtime value schema ${identity} has no composed neutral definition`,
        })
      }
    }
    return runtimeByIdentity
  })

/** Decode an unknown value through the executable schema named by a neutral reference. */
export const decodeRegisteredValue = (args: {
  readonly registry: RuntimeValueSchemaRegistry
  readonly reference: RegisteredValueSchemaReference
  readonly value: unknown
}): Effect.Effect<unknown, UnknownRuntimeValueSchemaError | RegisteredValueConformanceError> => {
  const runtimeSchema = args.registry.get(schemaIdentity(args.reference))
  if (runtimeSchema === undefined) {
    return Effect.fail(
      new UnknownRuntimeValueSchemaError({
        schemaId: args.reference.id,
        schemaVersion: args.reference.version,
        message: `No executable runtime schema is registered for ${schemaIdentity(args.reference)}`,
      }),
    )
  }
  return Schema.decodeUnknownEffect(runtimeSchema.schema)(args.value).pipe(
    Effect.mapError(
      (cause) =>
        new RegisteredValueConformanceError({
          schemaId: args.reference.id,
          schemaVersion: args.reference.version,
          actualType: actualType(args.value),
          reason: cause.issue._tag,
          message: `Value does not conform to registered schema ${schemaIdentity(args.reference)}`,
        }),
    ),
  )
}

/** Assert conformance while intentionally discarding a schema's decoded representation. */
export const assertRegisteredValueConforms = (args: {
  readonly registry: RuntimeValueSchemaRegistry
  readonly reference: RegisteredValueSchemaReference
  readonly value: unknown
}): Effect.Effect<void, UnknownRuntimeValueSchemaError | RegisteredValueConformanceError> =>
  decodeRegisteredValue(args).pipe(Effect.asVoid)
