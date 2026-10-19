import { DateTime, Duration, Schema, SchemaGetter } from 'effect'

import {
  referenceText,
  templateReferences,
  templateText,
  type DocumentReference,
  type RunReference,
  type TextTemplate,
} from './run-values.ts'
import type { SubjectRef } from './subject-ref.ts'

const Text = Schema.NonEmptyString
const strict = { onExcessProperty: 'error' } as const
const maxMillis = 18446744073709551615n
const rejectExcess = ({
  input,
  keys,
}: {
  readonly input: object
  readonly keys: readonly string[]
}): void => {
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)) === true)
    throw new TypeError('Unexpected canonical value input field')
}
/** Effect durations and explicit native/readable unit strings, never bare numbers. */
export type DurationInput = Duration.Duration | string
/** An Effect instant or a string carrying an explicit UTC/offset suffix. */
export type InstantInput =
  | DateTime.DateTime
  | `${string}Z`
  | `${string}${'+' | '-'}${number}:${number}`

/** Freeze canonical data, never the imported subject definition it points to. */
const freezeCanonical = <T>(value: T): T => {
  if (
    typeof value === 'object' &&
    value !== null &&
    !('_tag' in value && value._tag === 'SubjectRef')
  ) {
    for (const nested of Object.values(value)) freezeCanonical(nested)
    Object.freeze(value)
  }
  return value
}
/** Closed on both decoder and type predicates, including Schema.is callers. */
const canonicalCodec = <TSchema extends Schema.ConstraintCodec<unknown, unknown>>(
  shape: TSchema,
) => {
  if (shape.ast._tag !== 'Union')
    throw new TypeError('Canonical values require a tagged union schema')
  const variants = new Map<string, ReadonlySet<PropertyKey>>()
  for (const member of shape.ast.types) {
    if (member._tag !== 'Objects') throw new TypeError('Canonical variants require object schemas')
    const tag = member.propertySignatures.find((field) => field.name === '_tag')?.type
    if (tag?._tag !== 'Literal' || typeof tag.literal !== 'string')
      throw new TypeError('Canonical variants require string tags')
    variants.set(tag.literal, new Set(member.propertySignatures.map((field) => field.name)))
  }
  const closed = (input: unknown): boolean => {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('_tag' in input) ||
      typeof input._tag !== 'string'
    )
      return false
    const keys = variants.get(input._tag)
    return keys !== undefined && Reflect.ownKeys(input).every((key) => keys.has(key))
  }
  const isCanonicalShape = Schema.is(Schema.toType(shape))
  const canonical = Schema.declare<TSchema['Type']>(
    (input): input is TSchema['Type'] => closed(input) && isCanonicalShape(input),
  )
  // Check raw keys before the object decoder can strip them; the shape remains
  // the sole authority for field values and performs exactly one full decode.
  const closedShape = Schema.decodeTo(shape)(
    Schema.declare<TSchema['Encoded']>((input): input is TSchema['Encoded'] => closed(input)),
  )
  return Schema.decodeTo<typeof canonical, typeof closedShape>(canonical, {
    // Decode the shape once; the terminal declaration does not clone frozen data.
    decode: SchemaGetter.transform(freezeCanonical<TSchema['Type']>),
    encode: SchemaGetter.transform((input) => input),
  })(closedShape)
}
const invalidDuration = (): never => {
  throw new TypeError(
    'Duration must be finite, lossless integer milliseconds within native u64 bounds',
  )
}
const scales = { ms: 1n, s: 1000n, m: 60000n, h: 3600000n, d: 86400000n } as const
const readableScales: Readonly<Record<string, bigint>> = {
  nano: 1n,
  nanos: 1n,
  micro: 1000n,
  micros: 1000n,
  milli: 1000000n,
  millis: 1000000n,
  second: 1000000000n,
  seconds: 1000000000n,
  minute: 60000000000n,
  minutes: 60000000000n,
  hour: 3600000000000n,
  hours: 3600000000000n,
  day: 86400000000000n,
  days: 86400000000000n,
  week: 604800000000000n,
  weeks: 604800000000000n,
}

/** Native compact units and Effect readable units; never implicit numeric milliseconds. */
export const normalizeDuration = ({
  input,
  allowZero = false,
}: {
  readonly input: DurationInput
  readonly allowZero?: boolean
}): string => {
  let millis: bigint
  if (typeof input === 'string') {
    const native = /^(\d+)(ms|s|m|h|d)$/u.exec(input)
    if (native !== null) millis = BigInt(native[1]!) * scales[native[2] as keyof typeof scales]
    else {
      // Effect is the authority for readable syntax and supported units; the exact
      // decimal arithmetic below prevents its floating-point conversion losing data.
      if (Duration.fromInput(input as Duration.Input)._tag === 'None') return invalidDuration()
      const readable = /^(-?\d+)(?:\.(\d+))?\s+(\w+)$/u.exec(input)
      if (readable === null) return invalidDuration()
      const scale = readableScales[readable[3]!]
      if (scale === undefined) return invalidDuration()
      // Evaluate the decimal exactly: Effect's numeric parser may round a fractional
      // input before it reaches the integer-millisecond native boundary.
      const fraction = readable[2] ?? ''
      const denominator = 10n ** BigInt(fraction.length)
      const numerator = BigInt(`${readable[1]}${fraction}`) * scale
      const divisor = denominator * 1000000n
      if (numerator % divisor !== 0n) return invalidDuration()
      millis = numerator / divisor
    }
  } else {
    if (Duration.isDuration(input) === false) return invalidDuration()
    millis = Duration.match(input, {
      onMillis: (value) =>
        Number.isSafeInteger(value) === true ? BigInt(value) : invalidDuration(),
      onNanos: (value) => (value % 1000000n === 0n ? value / 1000000n : invalidDuration()),
      onInfinity: invalidDuration,
      onNegativeInfinity: invalidDuration,
    })
  }
  if (millis < 0n || (millis === 0n && allowZero !== true) || millis > maxMillis)
    return invalidDuration()
  return `${millis}ms`
}

const normalizableDuration = (allowZero: boolean) =>
  Schema.declare<DurationInput>((value): value is DurationInput => {
    if (typeof value !== 'string' && Duration.isDuration(value) === false) return false
    try {
      normalizeDuration({ input: value, allowZero })
      return true
    } catch {
      return false
    }
  }).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) => normalizeDuration({ input: value, allowZero })),
      encode: SchemaGetter.transform((value) => normalizeDuration({ input: value, allowZero })),
    }),
  )
/** Positive native u64 millisecond durations, normalized immediately. */
export const DurationSchema = normalizableDuration(false).annotate({ identifier: 'St.Duration' })
/** Native u64 millisecond durations for fields where zero is meaningful. */
export const NonNegativeDurationSchema = normalizableDuration(true).annotate({
  identifier: 'St.NonNegativeDuration',
})

/** Explicit offsets only; Effect owns parsing and UTC conversion. */
export const normalizeInstant = (input: DateTime.DateTime | string): `${string}Z` => {
  if (typeof input !== 'string' && DateTime.isDateTime(input) === false)
    throw new TypeError('Instant requires an Effect DateTime or explicit-offset ISO string')
  if (typeof input === 'string') {
    const match =
      /^(\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
        input,
      )
    if (match === null || /[1-9]/u.test((match[2] ?? '').slice(3)) === true)
      throw new TypeError('Instant requires an explicit offset and exact millisecond precision')
    // Detect calendar rollover permitted by JavaScript's parser without implementing
    // a second calendar engine. Parse the wall time through Effect and round-trip it.
    const wall = DateTime.formatIso(
      DateTime.makeUnsafe(`${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`),
    )
    if (wall.slice(0, 19) !== match[1]) throw new TypeError('Invalid calendar instant')
  }
  const value = DateTime.toUtc(DateTime.makeUnsafe(input))
  if (Number.isSafeInteger(value.epochMilliseconds) === false)
    throw new TypeError('Instant loses millisecond precision')
  const iso = DateTime.formatIso(value)
  if (/^\d{4}-/u.test(iso) === false)
    throw new TypeError('Instant outside native four-digit year range')
  return `${iso.slice(0, -1)}Z`
}
/** Explicit-offset Effect instants normalized to lossless UTC ISO strings. */
export const InstantSchema = Schema.declare<InstantInput>((value): value is InstantInput => {
  if (typeof value !== 'string' && DateTime.isDateTime(value) === false) return false
  try {
    normalizeInstant(value)
    return true
  } catch {
    return false
  }
})
  .pipe(
    Schema.decodeTo(Schema.TemplateLiteral([Schema.String, 'Z']), {
      decode: SchemaGetter.transform(normalizeInstant),
      encode: SchemaGetter.transform(normalizeInstant),
    }),
  )
  .annotate({ identifier: 'St.Instant' })

/** Native local wall-clock time in 24-hour HH:MM form. */
export const CalendarTimeSchema = Schema.String.pipe(
  Schema.refine((s): s is string => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(s), {
    message: 'calendar at must be a valid 24-hour HH:MM',
  }),
  Schema.brand('CalendarTime'),
).annotate({ identifier: 'St.CalendarTime' })
/** A timezone recognized by the runtime IANA timezone database. */
export const IanaTimezoneSchema = Schema.String.pipe(
  Schema.refine(
    (s): s is string => {
      if (/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/u.test(s) === false) return false
      try {
        Intl.DateTimeFormat(undefined, { timeZone: s })
        return true
      } catch {
        return false
      }
    },
    { message: 'unknown IANA timezone' },
  ),
  Schema.brand('IanaTimezone'),
).annotate({ identifier: 'St.IanaTimezone' })
/** The native calendar's optional single weekly day. */
export const CalendarDaysSchema = Schema.Tuple([
  Schema.Literals(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
]).annotate({ identifier: 'St.CalendarDays' })

const validName = ({
  value: s,
  full,
}: {
  readonly value: string
  readonly full: boolean
}): boolean =>
  s.length > 0 &&
  s.length <= 512 &&
  /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(s) &&
  s.split('/').every((part) => part !== '' && part !== '..') &&
  (!full || s.includes('/'))
const validSubject = (s: string): boolean => {
  if (/^\$\{[A-Za-z0-9_.-]*\}$/u.test(s) === true) return true
  const concrete = s.replace(/\$\{[^}]*\}/gu, 'x')
  if (concrete.includes('${') === true) return false
  if (concrete.startsWith('file/') === true) {
    const colon = concrete.indexOf(':')
    const host = concrete.slice(5, colon)
    const path = concrete.slice(colon + 1)
    return (
      colon > 5 &&
      validName({ value: host, full: false }) &&
      path.startsWith('/') &&
      !path.includes('/../') &&
      !path.endsWith('/..')
    )
  }
  return validName({ value: concrete, full: true })
}
/** Native graph subjects, including file subjects and run interpolation. */
export const FullSubject = Text.pipe(Schema.refine((s): s is string => validSubject(s)))
/** Native document names or immutable document revisions. */
export const DocumentReferenceSchema = Text.pipe(
  Schema.refine((s): s is string => {
    if (s.startsWith('doc/') === false) return false
    if (s.includes('${') === true) return true
    const at = s.lastIndexOf('@')
    const name = at < 0 ? s : s.slice(0, at)
    return (
      name.length > 4 &&
      !name.includes('..') &&
      !name.endsWith('/') &&
      (at < 0 || /^[0-9a-fA-F]{64}$/u.test(s.slice(at + 1)))
    )
  }),
).annotate({ identifier: 'St.DocumentReference' })
/** Exact immutable document hash references without interpolation. */
export const PinnedDocumentReferenceSchema = DocumentReferenceSchema.pipe(
  Schema.refine((s): s is string => !s.includes('${') && /@[0-9a-fA-F]{64}$/u.test(s)),
).annotate({ identifier: 'St.PinnedDocumentReference' })
const isPinnedDocument = (input: unknown): boolean =>
  Schema.is(PinnedDocumentReferenceSchema)(input)

const EnvironmentName = Schema.String.pipe(
  Schema.refine((s): s is string => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(s)),
)
const launchFields = {
  cwd: Schema.optionalKey(Text),
  env: Schema.optionalKey(Schema.Record(EnvironmentName, Schema.String)),
  unset: Schema.optionalKey(Schema.Array(EnvironmentName)),
}
const LaunchShape = Schema.Union([
  Schema.TaggedStruct('Argv', {
    argv: Schema.NonEmptyArray(Schema.String).pipe(
      Schema.refine((argv): argv is typeof argv => argv[0].length > 0),
    ),
    ...launchFields,
  }),
  Schema.TaggedStruct('Shell', { command: Text, ...launchFields }),
])
  .pipe(
    Schema.refine(
      (value): value is typeof value =>
        (value.unset ?? []).every((name) => !Object.hasOwn(value.env ?? {}, name)),
      { message: 'launch cannot set and unset the same environment name' },
    ),
  )
  .annotate({ identifier: 'St.Launch', parseOptions: strict })
/** Closed, immutable Argv or Shell launch values. */
export const LaunchSchema = canonicalCodec(LaunchShape)
/** A normalized canonical process launch. */
export type Launch = typeof LaunchSchema.Type
/** Native launch environment and working-directory options. */
export interface LaunchOptions {
  readonly cwd?: string | TextTemplate
  readonly env?: Readonly<Record<string, string | TextTemplate>>
  readonly unset?: readonly string[]
}
/** Exactly one native-shaped launch form with optional environment settings. */
export type LaunchInput = LaunchOptions &
  (
    | { readonly argv: readonly [string | TextTemplate, ...(string | TextTemplate)[]] }
    | { readonly command: string | TextTemplate }
  )
const launchRefs = new WeakMap<Launch, readonly RunReference[]>()
/** Exact run references retained while authored launch text is normalized. */
export const launchReferences = (value: Launch): readonly RunReference[] =>
  launchRefs.get(value) ?? []
const makeLaunch = (input: LaunchInput): Launch => {
  rejectExcess({ input: input, keys: ['argv', 'command', 'cwd', 'env', 'unset'] })
  const references: RunReference[] = []
  const text = (value: string | TextTemplate): string => {
    if (typeof value !== 'string') references.push(...templateReferences(value))
    return templateText(value)
  }
  const { cwd, env, ...rest } = input
  const normalized = {
    ...rest,
    ...(cwd === undefined ? {} : { cwd: text(cwd) }),
    ...(env === undefined
      ? {}
      : { env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, text(value)])) }),
  }
  const value = Schema.decodeUnknownSync(
    LaunchSchema,
    strict,
  )(
    'argv' in input
      ? { ...normalized, _tag: 'Argv', argv: input.argv.map(text) }
      : { ...normalized, _tag: 'Shell', command: text(input.command) },
  )
  launchRefs.set(value, references)
  return value
}
/** Semantic and native-shaped constructors for canonical launches. */
export const Launch = {
  argv: (
    input: LaunchOptions & {
      readonly argv: readonly [string | TextTemplate, ...(string | TextTemplate)[]]
    },
  ): Launch => makeLaunch(input),
  shell: (input: LaunchOptions & { readonly command: string | TextTemplate }): Launch =>
    makeLaunch(input),
  from: makeLaunch,
}
/** Removes the canonical tag without changing native launch semantics. */
export const lowerLaunch = (input: Launch) => {
  const { _tag, ...native } = Schema.decodeUnknownSync(LaunchSchema, strict)(input)
  return native
}

/** Only latest-only catch-up is supported by the production native contract. */
export const CatchUpSchema = Schema.Literal('latest').annotate({ identifier: 'St.CatchUp' })
/** Production native catch-up behavior. */
export type CatchUp = typeof CatchUpSchema.Type
const TimingShape = Schema.Union([
  Schema.TaggedStruct('At', { at: InstantSchema }),
  Schema.TaggedStruct('Every', {
    every: DurationSchema,
    anchor: InstantSchema,
    catchUp: Schema.optionalKey(CatchUpSchema),
  }),
  Schema.TaggedStruct('Calendar', {
    at: CalendarTimeSchema,
    timezone: IanaTimezoneSchema,
    days: Schema.optionalKey(CalendarDaysSchema),
    catchUp: Schema.optionalKey(CatchUpSchema),
  }),
]).annotate({ identifier: 'St.Timing', parseOptions: strict })
/** Closed, immutable At, Every or Calendar timing values. */
export const TimingSchema = canonicalCodec(TimingShape)
/** A normalized canonical schedule timing. */
export type Timing = typeof TimingSchema.Type
/** Native local calendar timing in an explicit named timezone. */
export type CalendarInput = {
  readonly at: string
  readonly timezone: string
  readonly days?: readonly ['Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun']
  readonly catchUp?: CatchUp
}
/** Exactly one native-shaped schedule timing form. */
export type TimingInput =
  | { readonly at: InstantInput }
  | { readonly every: DurationInput; readonly anchor: InstantInput; readonly catchUp?: CatchUp }
  | { readonly calendar: Omit<CalendarInput, 'catchUp'>; readonly catchUp?: CatchUp }
const decodeTiming = Schema.decodeUnknownSync(TimingSchema, strict)
const fromTiming = (input: TimingInput): Timing => {
  rejectExcess({ input: input, keys: ['at', 'every', 'anchor', 'calendar', 'catchUp'] })
  if ('calendar' in input) {
    const { calendar, ...rest } = input
    // Validate both levels before flattening, so unknown outer fields cannot disappear.
    Schema.decodeUnknownSync(
      Schema.Struct({
        calendar: Schema.Struct({
          at: Schema.String,
          timezone: Schema.String,
          days: Schema.optionalKey(CalendarDaysSchema),
        }),
        catchUp: Schema.optionalKey(CatchUpSchema),
      }),
      strict,
    )(input)
    return decodeTiming({ _tag: 'Calendar', ...calendar, ...rest })
  }
  return decodeTiming({ _tag: 'every' in input ? 'Every' : 'At', ...input })
}
/** Semantic and native-shaped constructors for canonical timing. */
export const Timing = {
  at: (at: InstantInput): Timing => fromTiming({ at }),
  every: (input: {
    readonly every: DurationInput
    readonly anchor: InstantInput
    readonly catchUp?: CatchUp
  }): Timing => fromTiming(input),
  calendar: (input: CalendarInput): Timing => {
    rejectExcess({ input: input, keys: ['at', 'timezone', 'days', 'catchUp'] })
    return decodeTiming({ _tag: 'Calendar', ...input })
  },
  from: fromTiming,
}
/** Lowers canonical timing into its exact native-shaped constructor input. */
export const lowerTiming = (input: Timing): TimingInput => {
  const value = decodeTiming(input)
  if (value._tag === 'At') return { at: value.at }
  if (value._tag === 'Every') {
    const { _tag, ...native } = value
    return native
  }
  const { _tag, catchUp, ...calendar } = value
  return { calendar, ...(catchUp === undefined ? {} : { catchUp }) }
}

/** A subject-tree reference resolved before native review lowering. */
export type ReviewSubjectRef = SubjectRef<'agent' | 'mission' | 'schedule'>
const SubjectReferenceSchema = Schema.declare<ReviewSubjectRef>(
  (value): value is ReviewSubjectRef =>
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    value._tag === 'SubjectRef' &&
    'kind' in value &&
    (value.kind === 'agent' || value.kind === 'mission' || value.kind === 'schedule') &&
    'url' in value &&
    typeof value.url === 'string',
)
const ReviewShape = Schema.Union([
  Schema.TaggedStruct('Subject', {
    subject: Schema.Union([
      FullSubject.pipe(
        Schema.refine(
          (subject): subject is string =>
            !subject.startsWith('file/') && !isPinnedDocument(subject),
        ),
      ),
      SubjectReferenceSchema,
    ]),
  }),
  Schema.TaggedStruct('File', { host: Text, path: Text }).pipe(
    Schema.refine((value): value is typeof value =>
      validSubject(`file/${value.host}:${value.path}`),
    ),
  ),
  Schema.TaggedStruct('PinnedDocument', { reference: PinnedDocumentReferenceSchema }),
]).annotate({ identifier: 'St.Review', parseOptions: strict })
/** Closed, immutable subject, file or exact-document review values. */
export const ReviewSchema = canonicalCodec(ReviewShape)
/** A normalized canonical human-review target. */
export type Review = typeof ReviewSchema.Type
/** Authored review subjects with retained typed-reference provenance. */
export type ReviewSubjectInput =
  | string
  | TextTemplate
  | DocumentReference
  | RunReference
  | ReviewSubjectRef
const reviewRefs = new WeakMap<Review, readonly RunReference[]>()
/** Exact run references retained by a normalized review value. */
export const reviewReferences = (value: Review): readonly RunReference[] =>
  reviewRefs.get(value) ?? []
const decodeReview = Schema.decodeUnknownSync(ReviewSchema, strict)
const subjectReview = (input: ReviewSubjectInput): Review => {
  let subject: string | ReviewSubjectRef
  let references: readonly RunReference[] = []
  if (typeof input === 'string') subject = input
  else if ('_tag' in input) subject = input
  else if ('kind' in input && input.kind === 'template') {
    subject = input.text
    references = templateReferences(input)
  } else if ('kind' in input && input.kind === 'document') {
    subject = input.subject
    references = templateReferences(input)
  } else {
    subject = referenceText(input)
    references = [input]
  }
  const value =
    typeof subject === 'string' &&
    (subject.startsWith('file/') === true || isPinnedDocument(subject) === true)
      ? fromReview(subject)
      : decodeReview({ _tag: 'Subject', subject })
  reviewRefs.set(value, references)
  return value
}
const fromReview = (input: string): Review => {
  if (isPinnedDocument(input) === true)
    return decodeReview({ _tag: 'PinnedDocument', reference: input })
  if (input.startsWith('file/') === true) {
    const colon = input.indexOf(':')
    return decodeReview({ _tag: 'File', host: input.slice(5, colon), path: input.slice(colon + 1) })
  }
  return subjectReview(input)
}
/** Semantic and native-shaped constructors for canonical review targets. */
export const Review = {
  subject: subjectReview,
  file: (input: { readonly host: string; readonly path: string }): Review => {
    rejectExcess({ input: input, keys: ['host', 'path'] })
    return decodeReview({ _tag: 'File', ...input })
  },
  pinned: (reference: string): Review => decodeReview({ _tag: 'PinnedDocument', reference }),
  from: fromReview,
}
/** Lowers review targets to native subjects, rejecting unresolved tree references. */
export const lowerReview = (input: Review): string => {
  const value = decodeReview(input)
  if (value._tag === 'PinnedDocument') return value.reference
  if (value._tag === 'File') return `file/${value.host}:${value.path}`
  if (typeof value.subject !== 'string')
    throw new TypeError(
      'Review subject reference must be resolved by the subject tree before lowering',
    )
  return value.subject
}
