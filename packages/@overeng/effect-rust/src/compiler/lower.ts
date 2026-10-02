import { Schema, SchemaAST } from 'effect'
import { assertPortablePattern } from '../schema/pattern.ts'
import { discriminator } from '../schema/discriminator.ts'
import { reject, type ContractIR, type Definition, type Field, type Type, type Width } from './ir.ts'

const identifier = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, '_')
export const lower = (contracts: Readonly<Record<string, Schema.Constraint>>, contract = 'contracts'): ContractIR => {
  const defs: Record<string, Definition> = {}
  const names = new Map<SchemaAST.AST, string>()
  const used = new Map<string, SchemaAST.AST>()
  const roots = new Map<SchemaAST.AST, string>()
  for (const [name, schema] of Object.entries(contracts)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) reject(`$/${name}`, 'Invalid Rust contract name', 'Use an ASCII identifier')
    roots.set(schema.ast, name)
  }
  const register = (ast: SchemaAST.AST, proposed: string, path: string): Type => {
    const existing = names.get(ast)
    if (existing) return { kind: 'ref', name: existing }
    const name = identifier(proposed)
    if (used.has(name) && used.get(name) !== ast) reject(path, `Identifier collision ${name}`, 'Assign unique schema identifiers')
    used.set(name, ast); names.set(ast, name)
    let resolved = ast
    const suspends = new Set<SchemaAST.AST>()
    let annotations: Schema.Annotations.Annotations = {}
    while (resolved._tag === 'Suspend') {
      if (suspends.has(resolved)) return reject(path, 'Unproductive suspended recursion', 'Put recursion behind a struct, array or tagged-union value')
      if (resolved.encoding || resolved.checks || resolved.context?.constructorDefault) return reject(path, 'Refined or transformed suspension is not admitted', 'Put supported checks on the underlying portable value schema')
      annotations = { ...resolved.annotations, ...annotations }
      suspends.add(resolved); resolved = resolved.thunk()
    }
    names.set(resolved, name)
    if (Object.keys(annotations).length > 0) {
      resolved = SchemaAST.annotate(resolved, annotations)
      names.set(resolved, name)
    }
    defs[name] = definition(resolved, name, path)
    return { kind: 'ref', name }
  }
  const checks = (ast: SchemaAST.AST, path: string): { pattern?: string; flags?: 'u' | 'iu'; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; integer?: boolean } => {
    const result: { pattern?: string; flags?: 'u' | 'iu'; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; integer?: boolean } = {}
    const visit = (check: SchemaAST.Check<unknown>) => {
      if (check._tag === 'FilterGroup') { check.checks.forEach(visit); return }
      const representation = check.annotations?.representation
      if (!representation || typeof representation !== 'object' || !('id' in representation)) return reject(path, 'Opaque refinement', 'Use Wire vocabulary or supported Effect built-in checks')
      const payload = 'payload' in representation ? representation.payload : undefined
      const object = payload !== null && typeof payload === 'object' ? payload : {}
      const number = (key: string): number => { const value = Reflect.get(object, key); if (typeof value !== 'number' || !Number.isSafeInteger(value)) return reject(path, `Invalid ${key} bound`, 'Use a safe integer bound'); return value }
      switch (representation.id) {
        case 'effect/schema/isInt': result.integer = true; break
        case 'effect/schema/isBetween': result.minimum = Math.max(result.minimum ?? -Infinity, number('minimum')); result.maximum = Math.min(result.maximum ?? Infinity, number('maximum')); break
        case 'effect/schema/isGreaterThanOrEqualTo': result.minimum = Math.max(result.minimum ?? -Infinity, number('minimum')); break
        case 'effect/schema/isLessThanOrEqualTo': result.maximum = Math.min(result.maximum ?? Infinity, number('maximum')); break
        case 'effect/schema/isPattern': {
          const source = Reflect.get(object, 'source'); const flags = Reflect.get(object, 'flags')
          if (typeof source !== 'string' || (flags !== 'u' && flags !== 'iu')) return reject(path, 'Non-portable pattern', 'Use Wire.pattern(src, u or iu)')
          if (check.annotations?.['x-effect-rust-pattern'] !== source) return reject(path, 'ECMAScript end-anchor semantics are not portable', 'Replace Schema.isPattern with Wire.pattern to enforce full-string matching')
          if (result.pattern !== undefined) return reject(path, 'Pattern intersections need a reviewed lowering', 'Combine constraints into one portable named Wire.pattern')
          assertPortablePattern(source, flags, `${path}/pattern`); result.pattern = source; result.flags = flags; break
        }
        case 'effect/schema/isMinCodePoints': result.minLength = Math.max(result.minLength ?? 0, number('minCodePoints')); break
        case 'effect/schema/isMaxCodePoints': result.maxLength = Math.min(result.maxLength ?? Infinity, number('maxCodePoints')); break
        case 'effect/schema/isBetweenCodePoints': result.minLength = Math.max(result.minLength ?? 0, number('minimum')); result.maxLength = Math.min(result.maxLength ?? Infinity, number('maximum')); break
        default: reject(path, `Unsupported check ${representation.id}`, 'Replace it with a portable width/pattern/code-point check')
      }
    }
    ast.checks?.forEach(visit)
    return result
  }
  const scalar = (ast: SchemaAST.AST, path: string): Type | undefined => {
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
      if (typeof patch !== 'object' || patch === null || !('~effect/Schema' in patch)) reject(path, 'Invalid Patch annotation', 'Use Wire.Patch(schema)')
      const innerAST = patch as SchemaAST.AST
      const admitsNull = (node: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): boolean => {
        if (seen.has(node)) return false
        seen.add(node)
        if (node._tag === 'Null') return true
        if (node._tag === 'Suspend') return admitsNull(node.thunk(), seen)
        if (node._tag === 'Union') return node.types.some((member) => admitsNull(member, seen))
        return false
      }
      if (SchemaAST.isOptional(innerAST) || admitsNull(innerAST)) return reject(path, 'Patch value cannot itself be absent or null', 'Supply the non-null required value schema; Patch already represents omission and null')
      return { kind: 'patch', inner: type(innerAST, `${path}/value`) }
    }
    if (ast.encoding) reject(path, 'Unregistered transformation', 'Use explicit Wire semantic codecs; arbitrary transformations cannot cross the Rust boundary')
    if (ast.context?.constructorDefault) reject(path, 'Constructor default is not a portable wire contract', 'Make the field required or optional explicitly')
    if (ast._tag === 'Boolean') { if (ast.checks) checks(ast, path); return { kind: 'bool' } }
    if (ast._tag === 'Null') return { kind: 'null' }
    if (ast._tag === 'Number') {
      const width = annotations?.['x-effect-rust-width']
      const constraints = checks(ast, path)
      if (!constraints.integer || !['u8', 'u16', 'u32', 'i32'].includes(String(width))) reject(path, 'Number requires explicit integer width', 'Use Wire.U8/U16/U32/I32; unconstrained numbers are lossy')
      const intervals: Record<Width, readonly [number, number]> = { u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], i32: [-2147483648, 2147483647] }
      const interval = intervals[width as Width]
      if (constraints.minimum !== interval[0] || constraints.maximum !== interval[1]) reject(path, 'Integer refinements differ from width bounds', 'Use the exact Wire width contract (custom bounded integers need a validating named newtype)')
      return { kind: 'int', width: width as Width }
    }
    if (ast._tag === 'String' && !ast.checks) return { kind: 'string' }
    return undefined
  }
  const type = (ast: SchemaAST.AST, path: string): Type => {
    if (ast._tag === 'Suspend') {
      const seen = new Set<SchemaAST.AST>()
      let current: SchemaAST.AST = ast
      while (current._tag === 'Suspend') {
        const named = names.get(current)
        if (named) return { kind: 'ref', name: named }
        const annotation = current.annotations?.identifier
        if (typeof annotation === 'string') return register(current, annotation, path)
        if (seen.has(current)) return reject(path, 'Unproductive suspended recursion', 'Put recursion behind a struct, array or tagged-union value')
        if (current.encoding || current.checks || current.context?.constructorDefault) return reject(path, 'Refined or transformed suspension is not admitted', 'Put supported checks on the underlying portable value schema')
        seen.add(current); current = current.thunk()
      }
      return type(current, path)
    }
    const simple = scalar(ast, path); if (simple) return simple
    if (names.has(ast)) return { kind: 'ref', name: names.get(ast)! }
    const root = roots.get(ast)
    const annotation = Schema.resolveAnnotations(Schema.make(ast))?.identifier
    if (root || typeof annotation === 'string') return register(ast, root ?? String(annotation), path)
    if (ast._tag === 'String') reject(path, 'Constrained strings require an identifier', 'Add .annotate({identifier: "Domain.Name"})')
    if (ast._tag === 'Arrays') {
      if (ast.elements.length || ast.rest.length !== 1 || ast.checks) reject(path, 'Tuple or refined array is not admitted', 'Use Schema.Array with one portable element schema')
      return { kind: 'array', item: type(ast.rest[0]!, `${path}/items`) }
    }
    if (ast._tag === 'Union' && ast.types.length === 2 && ast.types.some((member) => member._tag === 'Null')) return { kind: 'nullable', inner: type(ast.types.find((member) => member._tag !== 'Null')!, path) }
    if (ast._tag === 'Objects' && ast.indexSignatures.length === 1 && ast.propertySignatures.length === 0 && !ast.checks) return { kind: 'record', key: type(ast.indexSignatures[0]!.parameter, `${path}/keys`), value: type(ast.indexSignatures[0]!.type, `${path}/values`) }
    if (ast._tag === 'Objects' || ast._tag === 'Union' || ast._tag === 'Literal') return register(ast, `${contract}_${used.size}`, path)
    return reject(path, `Unsupported AST ${ast._tag}`, 'Use portable strings, explicit widths, structs, arrays, records or tagged unions')
  }
  const definition = (ast: SchemaAST.AST, name: string, path: string): Definition => {
    const simple = scalar(ast, path); if (simple) return { kind: 'alias', type: simple }
    if (ast._tag === 'Suspend') return definition(ast.thunk(), name, path)
    if (ast._tag === 'String') { const constraints = checks(ast, path); return { kind: 'string', ...(constraints.pattern === undefined ? {} : { pattern: constraints.pattern, flags: constraints.flags }), ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }), ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }), ...(ast.annotations?.brands ? { brand: true } : {}) } }
    if (ast._tag === 'Literal' && typeof ast.literal === 'string') return { kind: 'literals', values: [ast.literal] }
    if (ast._tag === 'Union') {
      if (ast.checks || ast.options?.mode === 'oneOf') reject(path, 'Union checks or oneOf not admitted', 'Use a disjoint string-literal or tagged union')
      if (ast.types.every((member) => member._tag === 'Literal' && typeof member.literal === 'string')) return { kind: 'literals', values: ast.types.map((member) => String((member as SchemaAST.Literal).literal)) }
      if (ast.types.length === 2 && ast.types.some((member) => member._tag === 'Null')) return { kind: 'alias', type: { kind: 'nullable', inner: type(ast.types.find((member) => member._tag !== 'Null')!, path) } }
      const members = ast.types.map((member) => member._tag === 'Suspend' ? member.thunk() : member)
      if (!members.every((member) => member._tag === 'Objects')) return reject(path, 'Untagged union not portable', 'Use Schema.TaggedStruct members sharing a tag key')
      const tag = discriminator(members)
      if (typeof tag !== 'string') return reject(path, 'Union lacks a string discriminator', 'Use Schema.TaggedStruct or a shared literal tag key')
      const variants = members.map((member) => {
        const object = member as SchemaAST.Objects
        const discriminator = object.propertySignatures.find((field) => field.name === tag)!.type as SchemaAST.Literal
        if (typeof discriminator.literal !== 'string') return reject(path, 'Non-string discriminator', 'Use string tags')
        const variantName = identifier(`${name}_${discriminator.literal}`)
        const body = new SchemaAST.Objects(object.propertySignatures.filter((field) => field.name !== tag), object.indexSignatures, object.annotations, object.checks)
        register(body, variantName, `${path}/${discriminator.literal}`)
        return { tag: discriminator.literal, ref: variantName }
      })
      if (new Set(variants.map((variant) => variant.tag)).size !== variants.length) reject(path, 'Duplicate union tags', 'Use unique tags')
      return { kind: 'taggedUnion', tagField: tag, variants, ...(ast.annotations?.['x-effect-rust-non-exhaustive'] === true ? { nonExhaustive: true } : {}) }
    }
    if (ast._tag === 'Objects' && ast.indexSignatures.length === 0 && !ast.checks) {
      const fields: Field[] = ast.propertySignatures.map((field) => {
        if (typeof field.name !== 'string') return reject(path, 'Non-string field name', 'Use string JSON keys')
        return { wire: field.name, type: type(field.type, `${path}/${field.name}`), presence: SchemaAST.isOptional(field.type) ? 'optional' : 'required' }
      })
      const excess = ast.annotations?.['x-effect-rust-excess'] ?? 'error'
      if (excess !== 'error' && excess !== 'ignore') return reject(path, 'Invalid excess annotation', 'Use Wire.excess(error or ignore)')
      return { kind: 'struct', fields, excess, ...(ast.annotations?.['x-effect-rust-non-exhaustive'] === true ? { nonExhaustive: true } : {}) }
    }
    if (ast._tag === 'Objects' || ast._tag === 'Arrays') return { kind: 'alias', type: typeWithoutRoot(ast, path) }
    return reject(path, `Unsupported definition ${ast._tag}`, 'Use a portable contract schema')
  }
  const typeWithoutRoot = (ast: SchemaAST.AST, path: string): Type => {
    if (ast._tag === 'Arrays' && ast.elements.length === 0 && ast.rest.length === 1 && !ast.checks) return { kind: 'array', item: type(ast.rest[0]!, `${path}/items`) }
    if (ast._tag === 'Objects' && ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1 && !ast.checks) return { kind: 'record', key: type(ast.indexSignatures[0]!.parameter, `${path}/keys`), value: type(ast.indexSignatures[0]!.type, `${path}/values`) }
    return reject(path, 'Mixed record/struct or refined container', 'Use a strict struct or a typed record without container refinements')
  }
  for (const [name, schema] of Object.entries(contracts)) {
    const existing = names.get(schema.ast)
    if (existing && existing !== name) {
      if (used.has(name) && used.get(name) !== schema.ast) return reject(`$/${name}`, `Identifier collision ${name}`, 'Assign unique schema identifiers')
      used.set(name, schema.ast)
      defs[name] = { kind: 'alias', type: { kind: 'ref', name: existing } }
    } else register(schema.ast, name, `$/${name}`)
  }
  return { irVersion: 1, contract, defs: Object.fromEntries(Object.entries(defs).sort(([left], [right]) => left.localeCompare(right))) }
}
