import { Buffer } from 'node:buffer'

import { Schema } from 'effect'

const Name = Schema.String.pipe(
  Schema.refine(
    (value): value is string =>
      value.length > 0 && Buffer.byteLength(value, 'utf8') <= 160 && !/[\s/]/u.test(value),
    {
      message:
        'mission input name must be nonempty, slash/whitespace-free and at most 160 UTF-8 bytes',
    },
  ),
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

/** A native run-context value, interpolated by st rather than by the authoring process. */
export interface ContextReference {
  readonly kind: 'context'
  readonly name: 'ST_MISSION_RUN'
}

/** The attempt-independent run ID used in child-mission and document names. */
export const runId: ContextReference = { kind: 'context', name: 'ST_MISSION_RUN' }

/** Identity-bearing authored text, resolved only at the native wire boundary. */
export interface TextTemplate {
  readonly kind: 'template'
  readonly text: string
}

const referencesByTemplate = new WeakMap<object, readonly RunReference[]>()
const noReferences: readonly RunReference[] = []

/** Resolves authored text without discarding its identity before assembly. */
export const templateText = (value: string | TextTemplate): string =>
  typeof value === 'string' ? value : value.text

/** Exact input/product objects retained by text, document and child-mission tags. */
export const templateReferences = (value: object): readonly RunReference[] =>
  referencesByTemplate.get(value) ?? noReferences

type TemplateValue = string | number | boolean | RunReference | ContextReference | TextTemplate
const interpolate = (
  strings: TemplateStringsArray,
  values: readonly TemplateValue[],
): { readonly text: string; readonly references: readonly RunReference[] } => {
  let text = strings[0] ?? ''
  const references: RunReference[] = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (typeof value !== 'object') {
      text += String(value)
    } else if ('kind' in value && value.kind === 'context') {
      text += `\${${value.name}}`
    } else if ('kind' in value && value.kind === 'template') {
      text += value.text
      references.push(...templateReferences(value))
    } else {
      text += referenceText(value)
      references.push(value)
    }
    text += strings[index + 1] ?? ''
  }
  return { text, references }
}

/** Typed text interpolation; input references render as `${input.NAME}`. */
export const t = (
  strings: TemplateStringsArray,
  ...values: readonly TemplateValue[]
): TextTemplate => {
  const { text, references } = interpolate(strings, values)
  const value: TextTemplate = { kind: 'template', text }
  referencesByTemplate.set(value, references)
  return value
}

export interface DocumentReference {
  readonly kind: 'document'
  readonly subject: string
}

/** A document subject, including native input and run-context interpolation. */
export const doc = (
  strings: TemplateStringsArray,
  ...values: readonly TemplateValue[]
): DocumentReference => {
  const { text, references } = interpolate(strings, values)
  const value: DocumentReference = { kind: 'document', subject: text }
  referencesByTemplate.set(value, references)
  return value
}

export interface ChildMission {
  readonly kind: 'child-mission'
  readonly id: string
}

/** Distinguishes child mission outputs from the named graph-product record. */
export const isChildMission = (value: ChildMission | Products): value is ChildMission =>
  'kind' in value && value.kind === 'child-mission'

/** A ready child mission that a worker publishes as an attempt-bound step output. */
export const childMission = (
  strings: TemplateStringsArray,
  ...values: readonly TemplateValue[]
): ChildMission => {
  const { text, references } = interpolate(strings, values)
  const value: ChildMission = { kind: 'child-mission', id: text }
  referencesByTemplate.set(value, references)
  return value
}

export interface PullRequestReference {
  readonly kind: 'pull-request'
  readonly repo: string
  readonly number: number
}

/** A literal pull request locator for a native merged gate. */
export const pr = (repo: string, number: number): PullRequestReference => {
  if (
    /^[^/#\s]+\/[^/#\s]+$/u.test(repo) === false ||
    Number.isSafeInteger(number) === false ||
    number < 1
  )
    throw new TypeError('Pull request needs OWNER/REPO and a positive integer number')
  return { kind: 'pull-request', repo, number }
}

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
