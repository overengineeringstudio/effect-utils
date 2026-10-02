import { Exit, Schema, SchemaAST } from 'effect'

import { discriminator } from '../schema/discriminator.ts'
import { assertPortablePattern } from '../schema/pattern.ts'
import {
  reject,
  type ContractIR,
  type Definition,
  type Field,
  type Type,
  type Width,
} from './ir.ts'

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
  integer?: boolean
} => {
  const result: {
    pattern?: string
    flags?: 'u' | 'iu'
    minLength?: number
    maxLength?: number
    minimum?: number
    maximum?: number
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
      return reject(
        path,
        'Opaque refinement',
        'Use Wire vocabulary or supported Effect built-in checks',
      )
    const payload = 'payload' in representation ? representation.payload : undefined
    const object = payload !== null && typeof payload === 'object' ? payload : {}
    const number = (key: string): number => {
      const value = Reflect.get(object, key)
      if (typeof value !== 'number' || Number.isSafeInteger(value) === false)
        return reject(path, `Invalid ${key} bound`, 'Use a safe integer bound')
      return value
    }
    const pattern = ({ source, flags }: { source: string; flags: 'u' | 'iu' }) => {
      if (result.pattern !== undefined)
        return reject(
          path,
          'Pattern intersections need a reviewed lowering',
          'Combine constraints into one portable named Wire.pattern',
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
        result.minimum = Math.max(result.minimum ?? -Infinity, number('minimum'))
        result.maximum = Math.min(result.maximum ?? Infinity, number('maximum'))
        break
      case 'effect/schema/isGreaterThanOrEqualTo':
        result.minimum = Math.max(result.minimum ?? -Infinity, number('minimum'))
        break
      case 'effect/schema/isLessThanOrEqualTo':
        result.maximum = Math.min(result.maximum ?? Infinity, number('maximum'))
        break
      case 'effect/schema/isPattern': {
        const source = Reflect.get(object, 'source')
        const flags = Reflect.get(object, 'flags')
        if (typeof source !== 'string' || (flags !== 'u' && flags !== 'iu'))
          return reject(path, 'Non-portable pattern', 'Use Wire.pattern(src, u or iu)')
        // The pinned built-in pattern check full-matches the admitted anchored grammar.
        pattern({ source, flags })
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

const admitsNull = ({
  node,
  seen = new Set<SchemaAST.AST>(),
}: {
  node: SchemaAST.AST
  seen?: Set<SchemaAST.AST>
}): boolean => {
  if (seen.has(node) === true) return false
  seen.add(node)
  if (node._tag === 'Null') return true
  if (node._tag === 'Suspend') return admitsNull({ node: node.thunk(), seen })
  if (node._tag === 'Union') return node.types.some((member) => admitsNull({ node: member, seen }))
  return false
}

const identifier = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, '_')
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
    const format = annotations?.['x-effect-rust-format']
    if (format !== undefined) {
      if (format === 'u64-decimal') return { kind: 'u64' }
      if (format === 'i64-decimal') return { kind: 'i64' }
      if (format === 'date-time-millis') return { kind: 'dateTime' }
      reject(path, `Unknown semantic format ${String(format)}`, 'Use Wire.U64/I64/TimestampMillis')
    }
    const patch = annotations?.['x-effect-rust-patch']
    if (patch !== undefined) {
      if (typeof patch !== 'object' || patch === null || !('~effect/Schema' in patch))
        reject(path, 'Invalid Patch annotation', 'Use Wire.Patch(schema)')
      const innerAST = patch as SchemaAST.AST
      if (SchemaAST.isOptional(innerAST) === true || admitsNull({ node: innerAST }) === true)
        return reject(
          path,
          'Patch value cannot itself be absent or null',
          'Supply the non-null required value schema; Patch already represents omission and null',
        )
      return { kind: 'patch', inner: type({ ast: innerAST, path: `${path}/value` }) }
    }
    if (ast.encoding !== undefined)
      reject(
        path,
        'Unregistered transformation',
        'Use explicit Wire semantic codecs; arbitrary transformations cannot cross the Rust boundary',
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
    if (ast._tag === 'Null') return { kind: 'null' }
    if (ast._tag === 'Number') {
      const width = annotations?.['x-effect-rust-width']
      const constraints = portableChecks({ ast, path })
      if (
        constraints.integer !== true ||
        ['u8', 'u16', 'u32', 'i32'].includes(String(width)) === false
      )
        reject(
          path,
          'Number requires explicit integer width',
          'Use Wire.U8/U16/U32/I32; unconstrained numbers are lossy',
        )
      const intervals: Record<Width, readonly [number, number]> = {
        u8: [0, 255],
        u16: [0, 65535],
        u32: [0, 4294967295],
        i32: [-2147483648, 2147483647],
      }
      const interval = intervals[width as Width]
      if (constraints.minimum !== interval[0] || constraints.maximum !== interval[1])
        reject(
          path,
          'Integer refinements differ from width bounds',
          'Use the exact Wire width contract (custom bounded integers need a validating named newtype)',
        )
      return { kind: 'int', width: width as Width }
    }
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
        ...(ast.annotations?.['x-effect-rust-non-exhaustive'] === true
          ? { nonExhaustive: true }
          : {}),
      }
    }
    if (ast._tag === 'Objects' && ast.indexSignatures.length === 0 && ast.checks === undefined) {
      const fields: Field[] = ast.propertySignatures.map((field) => {
        if (typeof field.name !== 'string')
          return reject(path, 'Non-string field name', 'Use string JSON keys')
        return {
          wire: field.name,
          type: type({ ast: field.type, path: `${path}/${field.name}` }),
          presence: SchemaAST.isOptional(field.type) === true ? 'optional' : 'required',
        }
      })
      const excess = ast.annotations?.['x-effect-rust-excess'] ?? 'error'
      if (excess !== 'error' && excess !== 'ignore')
        return reject(path, 'Invalid excess annotation', 'Use Wire.excess(error or ignore)')
      return {
        kind: 'struct',
        fields,
        excess,
        ...(ast.annotations?.['x-effect-rust-non-exhaustive'] === true
          ? { nonExhaustive: true }
          : {}),
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
