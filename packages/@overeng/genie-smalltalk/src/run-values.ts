import { Schema } from 'effect'

const Name = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0 && !/[\s/]/u.test(value)),
)
const Scalar = Schema.Union([Schema.String, Schema.Boolean, Schema.Finite])

/** st's mission input grammar carries text/resource kind, not a resource schema. */
export const MissionInputSchema = Schema.Struct({
  name: Name,
  kind: Schema.Literals(['text', 'resource']),
})
/** A product is a required graph subject plus scalar field constraints. */
export const ProductSchema = Schema.Struct({
  subject: Schema.String.pipe(
    Schema.refine((value): value is string => /^(resource|message|agent|exec|pty)\//u.test(value)),
  ),
  fields: Schema.Record(Schema.String, Scalar),
}).pipe(
  Schema.refine(
    (value): value is typeof value =>
      !value.subject.startsWith('resource/') ||
      (typeof value.fields.kind === 'string' && value.fields.kind.length > 0),
  ),
)

const inputBrand = Symbol('MissionInput')
const productBrand = Symbol('StepProduct')

/** A named text value declared by the enclosing mission. */
export interface TextInput<TName extends string = string> {
  readonly [inputBrand]: true
  readonly name: TName
  readonly kind: 'text'
}
/** A named resource observation with static authoring kind metadata. */
export interface ResourceInput<TName extends string = string, TKind extends string = string> {
  readonly [inputBrand]: true
  readonly name: TName
  readonly kind: 'resource'
  /** Static authoring metadata; st pins the supplied resource observation at start. */
  readonly resourceKind: TKind
}
/** A mission's typed text or resource input declaration. */
export type InputHandle = TextInput | ResourceInput
/** Scalar graph-field constraints carried by a product. */
export type ProductFields = Readonly<Record<string, string | number | boolean>>
/** Identity-bearing graph product assigned to exactly one producing step. */
export interface ProductHandle<TFields extends ProductFields = ProductFields> {
  readonly [productBrand]: true
  readonly subject?: string
  readonly fields: TFields
}
/** Named products exposed by a step handle. */
export type Products = Readonly<Record<string, ProductHandle>>
/** A typed reference interpolated into native gate data. */
export type RunReference = InputHandle | ProductHandle

/** Constructors for per-run mission input declarations. */
export const input = {
  text: <const TName extends string>(name: TName): TextInput<TName> => {
    Schema.decodeSync(Name)(name)
    return { [inputBrand]: true, name, kind: 'text' }
  },
  resource: <const TName extends string, const TKind extends string>({
    name,
    kind,
  }: {
    readonly name: TName
    readonly kind: TKind
  }): ResourceInput<TName, TKind> => {
    Schema.decodeSync(Name)(name)
    if (kind.length === 0) throw new TypeError('Resource input needs a kind')
    return { [inputBrand]: true, name, kind: 'resource', resourceKind: kind }
  },
}

/** Constructors for scalar-constrained graph products. */
export const product = {
  /** Scalar field constraints on an existing non-resource graph subject. */
  field: <const TFields extends ProductFields>(options: {
    readonly subject: `message/${string}` | `agent/${string}` | `exec/${string}` | `pty/${string}`
    readonly fields: TFields
  }): ProductHandle<TFields> => ({ [productBrand]: true, ...options }),
  /** Omitted subject is scoped to this run, producing step, and product name. */
  resource: <const TKind extends string, const TFields extends ProductFields>(options: {
    readonly kind: TKind
    readonly subject?: `resource/${string}`
    readonly fields: TFields
  }): ProductHandle<TFields & { readonly kind: TKind }> => ({
    [productBrand]: true,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    fields: { ...options.fields, kind: options.kind },
  }),
}

/** Distinguishes identity-bearing input declarations from products. */
export const isInputHandle = (value: object): value is InputHandle => inputBrand in value
/** Rendered subjects assigned when product-owning steps are constructed. */
export const productSubjects = new WeakMap<ProductHandle, string>()
/** Interpolates a declared input or resolves a constructed step's product subject. */
export const referenceText = (ref: RunReference): string => {
  if (isInputHandle(ref) === true) return `\${input.${ref.name}}`
  const subject = productSubjects.get(ref)
  if (subject === undefined) throw new TypeError('Product handle must belong to a constructed step')
  return subject
}
