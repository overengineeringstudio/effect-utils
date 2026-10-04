import { Exit, Schema, SchemaAST } from 'effect'

import { discriminator } from '../schema/discriminator.ts'
import * as EffectRust from '../schema/effect-rust.ts'
import { assertPortablePattern } from '../schema/pattern.ts'
import { isTimestampAST } from '../schema/timestamp.ts'
import {
  reject,
  integerRanges,
  type ContractIR,
  type Definition,
  type Field,
  type Type,
  type Width,
} from './ir.ts'

/** Lowers live Effect schemas into the portable contract IR, rejecting lossy constructs. */
// eslint-disable-next-line overeng/named-args -- Preserve the public lower positional SDK signature.
export const lower = (
  contracts: Readonly<Record<string, Schema.Constraint>>,
  contract = 'contracts',
): ContractIR => {
  const defs: Record<string, Definition> = {}
  const names = new Map<SchemaAST.AST, string>()
  const used = new Map<string, SchemaAST.AST>()
  const roots = new Map<SchemaAST.AST, string>()
  for (const [name, schema] of Object.entries(contracts)) {
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name) === false)
      reject(`$/${name}`, 'Invalid Rust contract name', 'Use an ASCII identifier')
    roots.set(schema.ast, name)
  }
  const register = ({
    ast,
    proposed,
    path,
  }: {
    ast: SchemaAST.AST
    proposed: string
    path: string
  }): Type => {
    const existing = names.get(ast)
    if (existing !== undefined && existing !== '') return { kind: 'ref', name: existing }
    const name = identifier(proposed)
    if (used.has(name) === true && used.get(name) !== ast)
      reject(path, `Identifier collision ${name}`, 'Assign unique schema identifiers')
    used.set(name, ast)
    names.set(ast, name)
    let resolved = ast
    const suspends = new Set<SchemaAST.AST>()
    let annotations: Schema.Annotations.Annotations = {}
    while (resolved._tag === 'Suspend') {
      if (suspends.has(resolved) === true)
        return reject(
          path,
          'Unproductive suspended recursion',
          'Put recursion behind a struct, array or tagged-union value',
        )
      if (
        resolved.encoding !== undefined ||
        resolved.checks !== undefined ||
        resolved.context?.constructorDefault !== undefined
      )
        return reject(
          path,
          'Refined or transformed suspension is not admitted',
          'Put supported checks on the underlying portable value schema',
        )
      annotations = Object.assign({}, resolved.annotations, annotations)
      suspends.add(resolved)
      resolved = resolved.thunk()
    }
    names.set(resolved, name)
    if (Object.keys(annotations).length > 0) {
      resolved = Schema.make<Schema.Top>(resolved).annotate(annotations).ast
      names.set(resolved, name)
    }
    defs[name] = definition({ ast: resolved, name, path })
    return { kind: 'ref', name }
  }
  const scalar = ({ ast, path }: { ast: SchemaAST.AST; path: string }): Type | undefined => {
    const annotations = Schema.resolveAnnotations(Schema.make(ast))
    if (EffectRust.isF32AST(ast) === true) {
      if (ast.context?.constructorDefault !== undefined ||
          ast.encodingChecks !== undefined ||
          (annotations?.[EffectRust.width] !== undefined && annotations[EffectRust.width] !== 'f32'))
        return reject(path, 'Modified binary32 contract policy', 'Use EffectRust.F32 without defaults, encoded checks or a conflicting width')
      return { kind: 'f32' }
    }
    if (
      (ast._tag === 'Declaration' ||
        ast._tag === 'Arrays' ||
        ast._tag === 'Objects' ||
        ast._tag === 'Union') &&
      ast.encodingChecks !== undefined
    )
      return reject(
        path,
        'Encoded-side refinements are not admitted',
        'Put supported checks on the portable domain schema',
      )
    if (
      annotations?.[EffectRust.width] !== undefined &&
      ast._tag !== 'Number' &&
      ast._tag !== 'BigInt'
    )
      return reject(
        path,
        'Storage width on a non-integer schema',
        'Pin widths only on bounded Schema.Int or Schema.BigInt',
      )
    const precision = annotations?.[EffectRust.timestampPrecision]
    if (precision !== undefined) {
      if (
        precision !== 'millis' ||
        isTimestampAST(ast) === false ||
        ast.checks !== undefined ||
        ast.context?.constructorDefault !== undefined
      )
        return reject(
          path,
          'Unsupported timestamp declaration',
          'Annotate unmodified Schema.DateTimeUtc with millisecond precision',
        )
      return { kind: 'dateTime' }
    }
    if (ast.encoding !== undefined)
      reject(
        path,
        'Unregistered transformation',
        'Use plain portable schemas; arbitrary transformations cannot cross the Rust boundary',
      )
    const constructorDefault = ast.context?.constructorDefault
    if (
      constructorDefault !== undefined &&
      !(
        ast._tag === 'Literal' &&
        typeof ast.literal === 'string' &&
        ast.checks === undefined &&
        Exit.isExit(constructorDefault) === true &&
        Exit.isSuccess(constructorDefault) === true &&
        constructorDefault.value === ast.literal
      )
    )
      reject(
        path,
        'Constructor default is not a portable wire contract',
        'Use a required tagged literal with its constant constructor default, or an explicit optional field',
      )
    if (ast._tag === 'Boolean') {
      if (ast.checks !== undefined) portableChecks({ ast, path })
      return { kind: 'bool' }
    }
    if (ast._tag === 'Null') {
      if (ast.checks !== undefined) portableChecks({ ast, path })
      return { kind: 'null' }
    }
    if (ast._tag === 'Number') {
      const constraints = portableChecks({ ast, path })
      const { minimum, maximum } = constraints
      if (
        constraints.integer !== true ||
        minimum === undefined ||
        maximum === undefined ||
        Number.isSafeInteger(minimum) === false ||
        Number.isSafeInteger(maximum) === false ||
        minimum > maximum
      )
        return reject(
          path,
          'Number requires a nonempty bounded integer interval',
          'Use Schema.Int with safe integer minimum and maximum checks',
        )
      const pin = annotations?.[EffectRust.width]
      const width =
        pin ??
        (Object.keys(integerRanges) as Width[]).find((candidate) => {
          const [lo, hi] = integerRanges[candidate]
          return minimum >= lo && maximum <= hi
        })
      if (typeof width !== 'string' || Object.hasOwn(integerRanges, width) === false)
        return reject(
          path,
          'Integer interval has no admitted number storage width',
          'Use bounds within the safe-number range and a fitting u8/u16/u32/i8/i16/i32/u64/i64 width',
        )
      const storage = width as Width
      const [lo, hi] = integerRanges[storage]
      if (minimum < lo || maximum > hi)
        return reject(
          path,
          'Integer bounds exceed pinned width',
          'Remove the width pin or choose a storage width containing the complete interval',
        )
      return {
        kind: 'int',
        width: storage,
        ...(minimum === lo && maximum === hi ? {} : { minimum, maximum }),
      }
    }
    if (ast._tag === 'BigInt') {
      const constraints = portableChecks({ ast, path })
      const minimum = constraints.minimumBigInt
      const maximum = constraints.maximumBigInt
      if (minimum === undefined || maximum === undefined || minimum > maximum)
        return reject(
          path,
          'BigInt requires a nonempty bounded interval',
          'Use inclusive or exclusive BigInt minimum and maximum checks',
        )
      const pin = annotations?.[EffectRust.width]
      const width = pin ?? (minimum >= 0n ? 'u64' : 'i64')
      if (width !== 'u64' && width !== 'i64')
        return reject(path, 'BigInt width must be u64 or i64', 'Choose a fitting 64-bit width')
      const lo = width === 'u64' ? 0n : -(2n ** 63n)
      const hi = width === 'u64' ? 2n ** 64n - 1n : 2n ** 63n - 1n
      if (minimum < lo || maximum > hi)
        return reject(
          path,
          'BigInt bounds exceed storage width',
          'Use bounds fitting the pinned or inferred 64-bit width',
        )
      return {
        kind: width,
        ...(minimum === lo && maximum === hi
          ? {}
          : { minimum: minimum.toString(), maximum: maximum.toString() }),
      }
    }
    if (ast._tag === 'Literal' && ast.checks !== undefined)
      return reject(
        path,
        'Refined literal is not admitted',
        'Use an unrefined literal or a supported named string schema',
      )
    if (ast._tag === 'Union' && (ast.checks !== undefined || ast.options?.mode === 'oneOf'))
      return reject(
        path,
        'Refined union is not admitted',
        'Use a disjoint literal, nullable or tagged union without additional checks',
      )
    if (ast._tag === 'String' && ast.checks === undefined) return { kind: 'string' }
    return undefined
  }
  const type = ({ ast, path }: { ast: SchemaAST.AST; path: string }): Type => {
    // optionalKey clones the AST only to change key context. Reuse the original
    // nominal definition, never structurally merge independent filters/codecs.
    if (ast.context?.isOptional === true && ast.context.constructorDefault === undefined) {
      const original = [...roots.keys(), ...names.keys()].find(
        (candidate) =>
          candidate !== ast &&
          candidate.context?.isOptional !== true &&
          candidate.context?.constructorDefault === undefined &&
          (candidate.context?.isMutable ?? false) === ast.context?.isMutable &&
          candidate.context?.annotations === ast.context?.annotations &&
          Object.keys(ast).every(
            (key) => key === 'context' || Reflect.get(ast, key) === Reflect.get(candidate, key),
          ),
      )
      if (original !== undefined) return type({ ast: original, path })
    }
    if (ast._tag === 'Suspend') {
      const seen = new Set<SchemaAST.AST>()
      let current: SchemaAST.AST = ast
      while (current._tag === 'Suspend') {
        const named = names.get(current)
        if (named !== undefined && named !== '') return { kind: 'ref', name: named }
        const annotation = current.annotations?.identifier
        if (typeof annotation === 'string')
          return register({ ast: current, proposed: annotation, path })
        if (seen.has(current) === true)
          return reject(
            path,
            'Unproductive suspended recursion',
            'Put recursion behind a struct, array or tagged-union value',
          )
        if (
          current.encoding !== undefined ||
          current.checks !== undefined ||
          current.context?.constructorDefault !== undefined
        )
          return reject(
            path,
            'Refined or transformed suspension is not admitted',
            'Put supported checks on the underlying portable value schema',
          )
        seen.add(current)
        current = current.thunk()
      }
      return type({ ast: current, path })
    }
    const simple = scalar({ ast, path })
    if (simple !== undefined) return simple
    if (names.has(ast) === true) return { kind: 'ref', name: names.get(ast)! }
    const root = roots.get(ast)
    const annotation = Schema.resolveAnnotations(Schema.make(ast))?.identifier
    if ((root !== undefined && root !== '') || typeof annotation === 'string')
      return register({ ast, proposed: root ?? String(annotation), path })
    if (ast._tag === 'String')
      reject(
        path,
        'Constrained strings require an identifier',
        'Add .annotate({identifier: "Domain.Name"})',
      )
    if (ast._tag === 'Arrays') {
      if (ast.elements.length !== 0 || ast.rest.length !== 1 || ast.checks !== undefined)
        reject(
          path,
          'Tuple or refined array is not admitted',
          'Use Schema.Array with one portable element schema',
        )
      return { kind: 'array', item: type({ ast: ast.rest[0]!, path: `${path}/items` }) }
    }
    if (
      ast._tag === 'Union' &&
      ast.types.length === 2 &&
      ast.types.some((member) => member._tag === 'Null') === true
    )
      return {
        kind: 'nullable',
        inner: type({ ast: ast.types.find((member) => member._tag !== 'Null')!, path }),
      }
    if (
      ast._tag === 'Objects' &&
      ast.indexSignatures.length === 1 &&
      ast.propertySignatures.length === 0 &&
      ast.checks === undefined
    )
      return {
        kind: 'record',
        key: type({ ast: ast.indexSignatures[0]!.parameter, path: `${path}/keys` }),
        value: type({ ast: ast.indexSignatures[0]!.type, path: `${path}/values` }),
      }
    if (ast._tag === 'Objects' || ast._tag === 'Union' || ast._tag === 'Literal')
      return register({ ast, proposed: `${contract}_${used.size}`, path })
    return reject(
      path,
      `Unsupported AST ${ast._tag}`,
      'Use portable strings, explicit widths, structs, arrays, records or tagged unions',
    )
  }
  const definition = ({
    ast,
    name,
    path,
  }: {
    ast: SchemaAST.AST
    name: string
    path: string
  }): Definition => {
    const simple = scalar({ ast, path })
    if (simple !== undefined) return { kind: 'alias', type: simple }
    if (ast._tag === 'Suspend') return definition({ ast: ast.thunk(), name, path })
    if (ast._tag === 'String') {
      const constraints = portableChecks({ ast, path })
      return {
        kind: 'string',
        ...(constraints.pattern === undefined
          ? {}
          : { pattern: constraints.pattern, flags: constraints.flags }),
        ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }),
        ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
        ...(Boolean(ast.annotations?.brands) === true ? { brand: true } : {}),
      }
    }
    if (ast._tag === 'Literal' && typeof ast.literal === 'string')
      return { kind: 'literals', values: [ast.literal] }
    if (ast._tag === 'Union') {
      if (ast.checks !== undefined || ast.options?.mode === 'oneOf')
        reject(
          path,
          'Union checks or oneOf not admitted',
          'Use a disjoint string-literal or tagged union',
        )
      if (
        ast.types.every(
          (member) => member._tag === 'Literal' && typeof member.literal === 'string',
        ) === true
      )
        return {
          kind: 'literals',
          values: ast.types.map((member) => String((member as SchemaAST.Literal).literal)),
        }
      if (ast.types.length === 2 && ast.types.some((member) => member._tag === 'Null') === true)
        return {
          kind: 'alias',
          type: {
            kind: 'nullable',
            inner: type({ ast: ast.types.find((member) => member._tag !== 'Null')!, path }),
          },
        }
      const members = ast.types.map((member) =>
        member._tag === 'Suspend' ? member.thunk() : member,
      )
      if (members.every((member) => member._tag === 'Objects') === false)
        return reject(
          path,
          'Untagged union not portable',
          'Use Schema.TaggedStruct members sharing a tag key',
        )
      const tag = discriminator(members)
      if (typeof tag !== 'string')
        return reject(
          path,
          'Union lacks a string discriminator',
          'Use Schema.TaggedStruct or a shared literal tag key',
        )
      const variants = members.map((member) => {
        const object = member as SchemaAST.Objects
        const tagLiteral = object.propertySignatures.find((field) => field.name === tag)!
          .type as SchemaAST.Literal
        if (typeof tagLiteral.literal !== 'string')
          return reject(path, 'Non-string discriminator', 'Use string tags')
        const variantName = identifier(`${name}_${tagLiteral.literal}`)
        const body = new SchemaAST.Objects(
          object.propertySignatures.filter((field) => field.name !== tag),
          object.indexSignatures,
          object.annotations,
          object.checks,
        )
        register({ ast: body, proposed: variantName, path: `${path}/${tagLiteral.literal}` })
        return { tag: tagLiteral.literal, ref: variantName }
      })
      if (new Set(variants.map((variant) => variant.tag)).size !== variants.length)
        reject(path, 'Duplicate union tags', 'Use unique tags')
      return {
        kind: 'taggedUnion',
        tagField: tag,
        variants,
        ...(ast.annotations?.[EffectRust.nonExhaustive] === true ? { nonExhaustive: true } : {}),
      }
    }
    if (ast._tag === 'Objects' && ast.indexSignatures.length === 0 && ast.checks === undefined) {
      const fields: Field[] = ast.propertySignatures.map((field) => {
        if (typeof field.name !== 'string')
          return reject(path, 'Non-string field name', 'Use string JSON keys')
        const value = optionalFieldValue({ ast: field.type })
        const lowered = type({ ast: value, path: `${path}/${field.name}` })
        const optional = SchemaAST.isOptional(field.type) === true
        let nullable = lowered
        const seen = new Set<string>()
        while (nullable.kind === 'ref' && seen.has(nullable.name) === false) {
          seen.add(nullable.name)
          const referenced = defs[nullable.name]
          if (referenced?.kind !== 'alias') break
          nullable = referenced.type
        }
        return {
          wire: field.name,
          type:
            optional === true && nullable.kind === 'nullable'
              ? { kind: 'patch', inner: nullable.inner }
              : lowered,
          presence: optional === true ? 'optional' : 'required',
        }
      })
      const excess = ast.annotations?.[EffectRust.excess] ?? 'error'
      if (excess !== 'error' && excess !== 'ignore')
        return reject(
          path,
          'Invalid excess annotation',
          'Use EffectRust.excess with error or ignore',
        )
      return {
        kind: 'struct',
        fields,
        excess,
        ...(ast.annotations?.[EffectRust.nonExhaustive] === true ? { nonExhaustive: true } : {}),
      }
    }
    if (ast._tag === 'Objects' || ast._tag === 'Arrays')
      return { kind: 'alias', type: typeWithoutRoot({ ast, path }) }
    return reject(path, `Unsupported definition ${ast._tag}`, 'Use a portable contract schema')
  }
  const typeWithoutRoot = ({ ast, path }: { ast: SchemaAST.AST; path: string }): Type => {
    if (
      ast._tag === 'Arrays' &&
      ast.elements.length === 0 &&
      ast.rest.length === 1 &&
      ast.checks === undefined
    )
      return { kind: 'array', item: type({ ast: ast.rest[0]!, path: `${path}/items` }) }
    if (
      ast._tag === 'Objects' &&
      ast.propertySignatures.length === 0 &&
      ast.indexSignatures.length === 1 &&
      ast.checks === undefined
    )
      return {
        kind: 'record',
        key: type({ ast: ast.indexSignatures[0]!.parameter, path: `${path}/keys` }),
        value: type({ ast: ast.indexSignatures[0]!.type, path: `${path}/values` }),
      }
    return reject(
      path,
      'Mixed record/struct or refined container',
      'Use a strict struct or a typed record without container refinements',
    )
  }
  for (const [name, schema] of Object.entries(contracts)) {
    const existing = names.get(schema.ast)
    if (existing !== undefined && existing !== '' && existing !== name) {
      if (used.has(name) === true && used.get(name) !== schema.ast)
        return reject(
          `$/${name}`,
          `Identifier collision ${name}`,
          'Assign unique schema identifiers',
        )
      used.set(name, schema.ast)
      defs[name] = { kind: 'alias', type: { kind: 'ref', name: existing } }
    } else register({ ast: schema.ast, proposed: name, path: `$/${name}` })
  }
  return {
    irVersion: 1,
    contract,
    defs: Object.fromEntries(
      // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
      Object.entries(defs).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}
// ECMAScript String.prototype.trim whitespace, not Rust regex's Unicode \s.
const trimWhitespace =
  '\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
const trimmedPattern = `^([^${trimWhitespace}]([\u0000-\u{10ffff}]*[^${trimWhitespace}])?)?$`

const portableChecks = ({
  ast,
  path,
}: {
  ast: SchemaAST.AST
  path: string
}): {
  pattern?: string
  flags?: 'u' | 'iu'
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minimumBigInt?: bigint
  maximumBigInt?: bigint
  integer?: boolean
} => {
  const result: {
    pattern?: string
    flags?: 'u' | 'iu'
    minLength?: number
    maxLength?: number
    minimum?: number
    maximum?: number
    minimumBigInt?: bigint
    maximumBigInt?: bigint
    integer?: boolean
  } = {}
  const visit = (check: SchemaAST.Check<unknown>) => {
    if (check._tag === 'FilterGroup') {
      check.checks.forEach(visit)
      return
    }
    const representation = check.annotations?.representation
    if (
      representation === undefined ||
      representation === null ||
      typeof representation !== 'object' ||
      !('id' in representation)
    )
      return reject(path, 'Opaque refinement', 'Use supported Effect built-in checks')
    const payload = 'payload' in representation ? representation.payload : undefined
    const object = payload !== null && typeof payload === 'object' ? payload : {}
    const number = (key: string): number => {
      const value = Reflect.get(object, key)
      if (typeof value !== 'number' || Number.isSafeInteger(value) === false)
        return reject(path, `Invalid ${key} bound`, 'Use a safe integer bound')
      return value
    }
    const bigint = (key: string): bigint => {
      const value = Reflect.get(object, key)
      if (typeof value !== 'string' || /^(0|-?[1-9][0-9]*)$/.test(value) === false)
        return reject(path, `Invalid ${key} bound`, 'Use a canonical bigint bound')
      return BigInt(value)
    }
    const lowerBigInt = (value: bigint) => {
      result.minimumBigInt =
        result.minimumBigInt === undefined || value > result.minimumBigInt
          ? value
          : result.minimumBigInt
    }
    const upperBigInt = (value: bigint) => {
      result.maximumBigInt =
        result.maximumBigInt === undefined || value < result.maximumBigInt
          ? value
          : result.maximumBigInt
    }
    const numeric =
      String(representation.id).startsWith('effect/schema/is') &&
      [
        'isInt',
        'isBetween',
        'isGreaterThanOrEqualTo',
        'isLessThanOrEqualTo',
        'isGreaterThan',
        'isLessThan',
      ].some((name) => representation.id === `effect/schema/${name}`)
    const wide = String(representation.id).endsWith('BigInt')
    if (
      (numeric === true && ast._tag !== 'Number') ||
      (wide === true && ast._tag !== 'BigInt') ||
      (numeric === false && wide === false && ast._tag !== 'String')
    )
      return reject(
        path,
        'Refinement applied to an incompatible value',
        'Use supported checks on their corresponding primitive schema',
      )
    const pattern = ({ source, flags }: { source: string; flags: 'u' | 'iu' }) => {
      if (result.pattern !== undefined)
        return reject(
          path,
          'Pattern intersections need a reviewed lowering',
          'Combine constraints into one portable named pattern',
        )
      assertPortablePattern(source, flags, `${path}/pattern`)
      result.pattern = source
      result.flags = flags
    }
    switch (representation.id) {
      case 'effect/schema/isInt':
        result.integer = true
        break
      case 'effect/schema/isBetween':
        result.minimum = Math.max(
          result.minimum ?? -Infinity,
          number('minimum') + (Reflect.get(object, 'exclusiveMinimum') === true ? 1 : 0),
        )
        result.maximum = Math.min(
          result.maximum ?? Infinity,
          number('maximum') - (Reflect.get(object, 'exclusiveMaximum') === true ? 1 : 0),
        )
        break
      case 'effect/schema/isGreaterThanOrEqualTo':
        result.minimum = Math.max(result.minimum ?? -Infinity, number('minimum'))
        break
      case 'effect/schema/isLessThanOrEqualTo':
        result.maximum = Math.min(result.maximum ?? Infinity, number('maximum'))
        break
      case 'effect/schema/isGreaterThan':
        result.minimum = Math.max(result.minimum ?? -Infinity, number('exclusiveMinimum') + 1)
        break
      case 'effect/schema/isLessThan':
        result.maximum = Math.min(result.maximum ?? Infinity, number('exclusiveMaximum') - 1)
        break
      case 'effect/schema/isBetweenBigInt':
        lowerBigInt(
          bigint('minimum') + (Reflect.get(object, 'exclusiveMinimum') === true ? 1n : 0n),
        )
        upperBigInt(
          bigint('maximum') - (Reflect.get(object, 'exclusiveMaximum') === true ? 1n : 0n),
        )
        break
      case 'effect/schema/isGreaterThanOrEqualToBigInt':
        lowerBigInt(bigint('minimum'))
        break
      case 'effect/schema/isLessThanOrEqualToBigInt':
        upperBigInt(bigint('maximum'))
        break
      case 'effect/schema/isGreaterThanBigInt':
        lowerBigInt(bigint('exclusiveMinimum') + 1n)
        break
      case 'effect/schema/isLessThanBigInt':
        upperBigInt(bigint('exclusiveMaximum') - 1n)
        break
      case 'effect/schema/isPattern': {
        const source = Reflect.get(object, 'source')
        const flags = Reflect.get(object, 'flags')
        if (typeof source !== 'string' || (flags !== 'u' && flags !== 'iu'))
          return reject(path, 'Non-portable pattern', 'Use Schema.isPattern with u or iu flags')
        // The pinned built-in pattern check full-matches the admitted anchored grammar.
        pattern({ source: source.replaceAll('\\/', '/'), flags })
        break
      }
      case 'effect/schema/isTrimmed':
        pattern({ source: trimmedPattern, flags: 'u' })
        break
      case 'effect/schema/isMinLength': {
        const minimum = number('minLength')
        if (minimum !== 0 && minimum !== 1)
          return reject(
            path,
            'UTF-16 length is not a code-point length',
            'Use Schema.isMinCodePoints; only nonempty (length >= 1) is equivalent',
          )
        result.minLength = Math.max(result.minLength ?? 0, minimum)
        break
      }
      case 'effect/schema/isMinCodePoints':
        result.minLength = Math.max(result.minLength ?? 0, number('minCodePoints'))
        break
      case 'effect/schema/isMaxCodePoints':
        result.maxLength = Math.min(result.maxLength ?? Infinity, number('maxCodePoints'))
        break
      case 'effect/schema/isBetweenCodePoints':
        result.minLength = Math.max(result.minLength ?? 0, number('minimum'))
        result.maxLength = Math.min(result.maxLength ?? Infinity, number('maximum'))
        break
      default:
        reject(
          path,
          `Unsupported check ${representation.id}`,
          'Replace it with a portable width/pattern/code-point check',
        )
    }
  }
  ast.checks?.forEach(visit)
  return result
}

/** Pinned Schema.optional wraps T in an optional-key Union([T, Undefined]). */
const optionalFieldValue = ({ ast }: { ast: SchemaAST.AST }): SchemaAST.AST => {
  if (
    SchemaAST.isOptional(ast) === true &&
    ast._tag === 'Union' &&
    ast.types.length === 2 &&
    ast.types.some((member) => member._tag === 'Undefined') === true &&
    ast.checks === undefined &&
    ast.encodingChecks === undefined &&
    ast.encoding === undefined &&
    ast.context?.constructorDefault === undefined &&
    ast.options?.mode !== 'oneOf'
  )
    return ast.types.find((member) => member._tag !== 'Undefined') ?? ast
  return ast
}

const identifier = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, '_')
