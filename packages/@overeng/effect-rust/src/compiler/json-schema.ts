import { integerRanges, reject, type ContractIR, type Definition, type Type } from './ir.ts'

/** Versioned vocabulary: consumers must implement these keywords, not silently ignore them. */
export const EFFECT_RUST_VOCABULARY = 'https://effect-rust.dev/schema/v1'
/** Every vocabulary keyword the emitter writes and the importer admits; any other keyword outside metadata rejects. */
export const EFFECT_RUST_KEYWORDS = [
  'x-effect-rust-width',
  'x-effect-rust-format',
  'x-effect-rust-pattern',
  'x-effect-rust-pattern-flags',
  'x-effect-rust-excess',
  'x-effect-rust-non-exhaustive',
  'x-effect-rust-patch',
  'x-effect-rust-minimum',
  'x-effect-rust-maximum',
] as const
/** JSON Schema object emitted with the versioned effect-rust vocabulary. */
export type JsonSchemaObject = { readonly [key: string]: unknown }

const pointer = (name: string): string =>
  encodeURIComponent(name.replaceAll('~', '~0').replaceAll('/', '~1'))

/** Emits the JSON control-plane contract, including lossless wire codec semantics. */
// eslint-disable-next-line overeng/named-args -- Preserve the public emitJsonSchema positional SDK signature.
export const emitJsonSchema = (ir: ContractIR, root: string): JsonSchemaObject => {
  if (Object.hasOwn(ir.defs, root) === false)
    reject('$', `unknown root ${root}`, 'Choose a definition in the contract IR')
  const type = ({
    value,
    property = false,
  }: {
    value: Type
    property?: boolean
  }): JsonSchemaObject => {
    switch (value.kind) {
      case 'string':
        return { type: 'string' }
      case 'bool':
        return { type: 'boolean' }
      case 'null':
        return { type: 'null' }
      case 'f32':
        return { type: 'number', format: 'float', 'x-effect-rust-width': 'f32', 'x-effect-rust-nonfinite': 'reject' }
      case 'int': {
        const [minimum, maximum] = integerRanges[value.width]
        return {
          type: 'integer',
          format: `${value.width.startsWith('i') === true ? 'int' : 'uint'}${value.width.slice(1)}`,
          minimum: value.minimum ?? minimum,
          maximum: value.maximum ?? maximum,
          'x-effect-rust-width': value.width,
        }
      }
      case 'u64':
      case 'i64':
        return {
          type: 'string',
          pattern: value.kind === 'u64' ? '^(0|[1-9][0-9]*)$' : '^(0|-?[1-9][0-9]*)$',
          'x-effect-rust-width': value.kind,
          'x-effect-rust-format': `${value.kind}-decimal`,
          ...(value.minimum === undefined ? {} : { 'x-effect-rust-minimum': value.minimum }),
          ...(value.maximum === undefined ? {} : { 'x-effect-rust-maximum': value.maximum }),
        }
      case 'dateTime':
        return { type: 'string', format: 'date-time', 'x-effect-rust-format': 'date-time-millis' }
      case 'nullable':
        return { anyOf: [{ type: 'null' }, type({ value: value.inner })] }
      case 'patch':
        if (property === false)
          return reject(
            '$',
            'Patch is only representable at an object property',
            'Place optionalKey(NullOr(T)) on a struct field; absence is not a standalone JSON value',
          )
        return {
          anyOf: [{ type: 'null' }, type({ value: value.inner })],
          'x-effect-rust-patch': true,
        }
      case 'array':
        return { type: 'array', items: type({ value: value.item }) }
      case 'record':
        return {
          type: 'object',
          propertyNames: type({ value: value.key }),
          additionalProperties: type({ value: value.value }),
        }
      case 'ref':
        if (Object.hasOwn(ir.defs, value.name) === false)
          return reject(
            '$',
            `missing reference ${value.name}`,
            'Include the referenced definition in the IR',
          )
        return { $ref: `#/$defs/${pointer(value.name)}` }
    }
  }
  const definition = ({ name, value }: { name: string; value: Definition }): JsonSchemaObject => {
    const annotation = { title: name }
    switch (value.kind) {
      case 'alias':
        return { ...annotation, ...type({ value: value.type }) }
      case 'string':
        return {
          ...annotation,
          type: 'string',
          ...(value.pattern === undefined
            ? {}
            : {
                pattern: value.pattern,
                'x-effect-rust-pattern': value.pattern,
                'x-effect-rust-pattern-flags': value.flags ?? 'u',
              }),
          ...(value.minLength === undefined ? {} : { minLength: value.minLength }),
          ...(value.maxLength === undefined ? {} : { maxLength: value.maxLength }),
        }
      case 'literals':
        return { ...annotation, type: 'string', enum: value.values }
      case 'struct':
        return {
          ...annotation,
          type: 'object',
          properties: Object.fromEntries(
            value.fields.map((field) => [field.wire, type({ value: field.type, property: true })]),
          ),
          required: value.fields
            .filter((field) => field.presence === 'required' && field.type.kind !== 'patch')
            .map((field) => field.wire),
          additionalProperties: false,
          'x-effect-rust-excess': value.excess ?? 'error',
          ...(value.nonExhaustive === undefined
            ? {}
            : { 'x-effect-rust-non-exhaustive': value.nonExhaustive }),
        }
      case 'taggedUnion':
        return {
          ...annotation,
          oneOf: value.variants.map((variant) => {
            const body = ir.defs[variant.ref]
            if (body?.kind !== 'struct')
              return reject(
                `$/$defs/${name}`,
                `variant ${variant.ref} is not a struct`,
                'Use a struct body for each tagged union variant',
              )
            if (body.fields.some((field) => field.wire === value.tagField) === true)
              return reject(
                `$/$defs/${name}`,
                'variant body contains the discriminator',
                'Keep the tag in taggedUnion metadata, not in the body fields',
              )
            // The union owns its discriminator; reusable body definitions stay tag-free.
            return {
              ...definition({ name: variant.ref, value: body }),
              properties: Object.fromEntries([
                [value.tagField, { type: 'string', const: variant.tag }],
                ...body.fields.map((field) => [
                  field.wire,
                  type({ value: field.type, property: true }),
                ]),
              ]),
              required: [
                value.tagField,
                ...body.fields
                  .filter((field) => field.presence === 'required' && field.type.kind !== 'patch')
                  .map((field) => field.wire),
              ],
            }
          }),
          ...(value.nonExhaustive === undefined
            ? {}
            : { 'x-effect-rust-non-exhaustive': value.nonExhaustive }),
        }
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $vocabulary: { [EFFECT_RUST_VOCABULARY]: true },
    title: root,
    $ref: `#/$defs/${pointer(root)}`,
    $defs: Object.fromEntries(
      Object.entries(ir.defs).map(([name, value]) => [name, definition({ name, value })]),
    ),
  }
}
