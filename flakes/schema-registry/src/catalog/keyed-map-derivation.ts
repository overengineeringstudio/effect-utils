import { Result, Schema } from 'effect'

import { patternMatchesExact } from './compose.ts'
import type { DerivationRule, TagPattern } from './schema.ts'

type KeyedMapTransform = Extract<DerivationRule['transform'], { readonly _tag: 'keyed-map' }>

interface KeyedMapEntry {
  readonly key: string
  readonly value: string
}

interface KeyedMapDerivationInput {
  readonly entries: ReadonlyArray<KeyedMapEntry>
  readonly launchContext: Readonly<Record<string, string>>
  readonly occupiedTargets?: ReadonlyArray<string>
  readonly catalog: {
    readonly tags: ReadonlyArray<
      | { readonly _tag: 'exact'; readonly key: string }
      | { readonly _tag: 'pattern'; readonly pattern: TagPattern }
    >
  }
  readonly transform: KeyedMapTransform
}

const DerivationErrorFields = {
  key: Schema.String,
  message: Schema.String,
}

class UnsafeKeyedMapKeyError extends Schema.TaggedError<UnsafeKeyedMapKeyError>()(
  'UnsafeKeyedMapKeyError',
  DerivationErrorFields,
) {}

class UnknownKeyedMapTargetError extends Schema.TaggedError<UnknownKeyedMapTargetError>()(
  'UnknownKeyedMapTargetError',
  DerivationErrorFields,
) {}

class DuplicateKeyedMapKeyError extends Schema.TaggedError<DuplicateKeyedMapKeyError>()(
  'DuplicateKeyedMapKeyError',
  DerivationErrorFields,
) {}

class KeyedMapOverlayCollisionError extends Schema.TaggedError<KeyedMapOverlayCollisionError>()(
  'KeyedMapOverlayCollisionError',
  DerivationErrorFields,
) {}

class UnknownLaunchContextVariableError extends Schema.TaggedError<UnknownLaunchContextVariableError>()(
  'UnknownLaunchContextVariableError',
  {
    ...DerivationErrorFields,
    variable: Schema.String,
  },
) {}

class MissingLaunchContextVariableError extends Schema.TaggedError<MissingLaunchContextVariableError>()(
  'MissingLaunchContextVariableError',
  {
    ...DerivationErrorFields,
    variable: Schema.String,
  },
) {}

class DuplicateLaunchContextVariableError extends Schema.TaggedError<DuplicateLaunchContextVariableError>()(
  'DuplicateLaunchContextVariableError',
  {
    ...DerivationErrorFields,
    variable: Schema.String,
  },
) {}

class InvalidLaunchContextValueError extends Schema.TaggedError<InvalidLaunchContextValueError>()(
  'InvalidLaunchContextValueError',
  {
    ...DerivationErrorFields,
    variable: Schema.String,
  },
) {}

class KeyedMapOutputTooLongError extends Schema.TaggedError<KeyedMapOutputTooLongError>()(
  'KeyedMapOutputTooLongError',
  {
    ...DerivationErrorFields,
    maximumOutputLength: Schema.Int,
    actualOutputLength: Schema.Int,
  },
) {}

type KeyedMapDerivationError =
  | UnsafeKeyedMapKeyError
  | UnknownKeyedMapTargetError
  | DuplicateKeyedMapKeyError
  | KeyedMapOverlayCollisionError
  | UnknownLaunchContextVariableError
  | MissingLaunchContextVariableError
  | DuplicateLaunchContextVariableError
  | InvalidLaunchContextValueError
  | KeyedMapOutputTooLongError

const SAFE_TAG_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const VARIABLE_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/

const targetIsAdmitted = (args: {
  readonly catalog: KeyedMapDerivationInput['catalog']
  readonly key: string
}): boolean =>
  args.catalog.tags.some((tag) =>
    tag._tag === 'exact'
      ? tag.key === args.key
      : patternMatchesExact({ pattern: tag.pattern, key: args.key }),
  )

const expandOnce = (args: {
  readonly key: string
  readonly template: string
  readonly launchContext: Readonly<Record<string, string>>
  readonly transform: KeyedMapTransform
}): Result.Result<string, KeyedMapDerivationError> => {
  const declarations = new Map(
    args.transform.variables.map((variable) => [variable.name, variable]),
  )
  let output = ''

  for (let index = 0; index < args.template.length;) {
    const character = args.template[index]
    if (character !== '$') {
      output += character
      index += 1
      continue
    }

    const braced = args.template[index + 1] === '{'
    const tail = braced ? args.template.slice(index + 2) : args.template.slice(index + 1)
    const match = VARIABLE_NAME_PREFIX.exec(tail)
    const name = match?.[0]
    const closingIndex = braced && name !== undefined ? index + 2 + name.length : -1
    if (name === undefined || (braced && args.template[closingIndex] !== '}')) {
      return Result.fail(
        new UnknownLaunchContextVariableError({
          key: args.key,
          variable: tail.split(/[}\s]/, 1)[0] ?? '',
          message: `Tag ${args.key} contains an invalid or unresolved launch-context reference`,
        }),
      )
    }

    const declaration = declarations.get(name)
    if (declaration === undefined) {
      return Result.fail(
        new UnknownLaunchContextVariableError({
          key: args.key,
          variable: name,
          message: `Tag ${args.key} references undeclared launch-context variable ${name}`,
        }),
      )
    }
    const value = args.launchContext[name]
    if (value === undefined) {
      return Result.fail(
        new MissingLaunchContextVariableError({
          key: args.key,
          variable: name,
          message: `Tag ${args.key} is missing declared launch-context variable ${name}`,
        }),
      )
    }
    if (declaration.value.nonEmpty === true && value.trim().length === 0) {
      return Result.fail(
        new InvalidLaunchContextValueError({
          key: args.key,
          variable: name,
          message: `Tag ${args.key} received an empty value for non-empty launch-context variable ${name}`,
        }),
      )
    }

    output += value
    index = braced ? closingIndex + 1 : index + 1 + name.length
  }

  if (output.length > args.transform.expansion.maximumOutputLength) {
    return Result.fail(
      new KeyedMapOutputTooLongError({
        key: args.key,
        maximumOutputLength: args.transform.expansion.maximumOutputLength,
        actualOutputLength: output.length,
        message: `Tag ${args.key} expands beyond ${args.transform.expansion.maximumOutputLength} characters`,
      }),
    )
  }
  return Result.succeed(output)
}

/**
 * Evaluates the managed keyed-map contract before PTY launch.
 *
 * Entries remain ordered until duplicate checks complete, and expansion reads
 * only the explicitly supplied launch context. It never reads process.env or a
 * shell and never recursively expands substituted values.
 */
export const deriveKeyedMapTags = (
  input: KeyedMapDerivationInput,
): Result.Result<Readonly<Record<string, string>>, KeyedMapDerivationError> => {
  const declaredVariables = new Set<string>()
  for (const variable of input.transform.variables) {
    if (declaredVariables.has(variable.name)) {
      return Result.fail(
        new DuplicateLaunchContextVariableError({
          key: '',
          variable: variable.name,
          message: `Launch-context variable ${variable.name} is declared more than once`,
        }),
      )
    }
    declaredVariables.add(variable.name)
  }
  const seen = new Set<string>()
  const occupied = new Set(input.occupiedTargets ?? [])
  const output: Array<readonly [string, string]> = []

  for (const entry of input.entries) {
    if (!SAFE_TAG_KEY.test(entry.key) || entry.key.includes('=')) {
      return Result.fail(
        new UnsafeKeyedMapKeyError({
          key: entry.key,
          message: `Task tag key ${JSON.stringify(entry.key)} is not a safe dot-segment PTY tag key`,
        }),
      )
    }
    if (!targetIsAdmitted({ catalog: input.catalog, key: entry.key })) {
      return Result.fail(
        new UnknownKeyedMapTargetError({
          key: entry.key,
          message: `Task tag key ${entry.key} is not admitted by the composed PTY tag catalog`,
        }),
      )
    }
    if (seen.has(entry.key)) {
      return Result.fail(
        new DuplicateKeyedMapKeyError({
          key: entry.key,
          message: `Task tag key ${entry.key} occurs more than once`,
        }),
      )
    }
    if (occupied.has(entry.key)) {
      return Result.fail(
        new KeyedMapOverlayCollisionError({
          key: entry.key,
          message: `Task tag key ${entry.key} collides with an existing target`,
        }),
      )
    }

    const expanded = expandOnce({
      key: entry.key,
      template: entry.value,
      launchContext: input.launchContext,
      transform: input.transform,
    })
    if (Result.isFailure(expanded)) return Result.fail(expanded.failure)
    seen.add(entry.key)
    output.push([entry.key, expanded.success])
  }

  return Result.succeed(Object.fromEntries(output))
}
