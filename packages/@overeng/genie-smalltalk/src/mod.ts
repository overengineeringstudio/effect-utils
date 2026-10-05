import { Schema } from 'effect'

import type { GenieOutput } from '@overeng/genie'

/** A KDL argument or property value. */
export type Value = string | number | boolean

/** A KDL node; `children: undefined` renders without a children block. */
export type Node = {
  readonly name: string
  readonly args: readonly Value[]
  readonly props: Readonly<Record<string, Value>>
  readonly children?: readonly Node[]
}

/** Builds a KDL node; omitted args and props are empty. */
export const node = ({
  name,
  args = [],
  props = {},
  children,
}: {
  readonly name: string
  readonly args?: readonly Value[]
  readonly props?: Readonly<Record<string, Value>>
  readonly children?: readonly Node[]
}): Node => ({ name, args, props, ...(children === undefined ? {} : { children }) })

const renderValue = (value: Value): string => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return `#${value}`
  if (Number.isFinite(value) === false) throw new RangeError('KDL numbers must be finite')
  return String(value)
}

const identifier = (text: string): string =>
  /^[A-Za-z_][\w-]*$/u.test(text) === true ? text : JSON.stringify(text)

const render = ({
  node: current,
  depth,
}: {
  readonly node: Node
  readonly depth: number
}): string => {
  const pad = '  '.repeat(depth)
  const args = current.args.map((arg) => ` ${renderValue(arg)}`).join('')
  const props = Object.entries(current.props)
    .toSorted(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, value]) => ` ${identifier(key)}=${renderValue(value)}`)
    .join('')
  const header = `${pad}${identifier(current.name)}${args}${props}`
  if (current.children === undefined) return `${header}\n`
  const body = current.children.map((child) => render({ node: child, depth: depth + 1 })).join('')
  return `${header} {\n${body}${pad}}\n`
}

/** Serializes nodes as a KDL v2 document. */
export const emit = (nodes: readonly Node[]): string =>
  `version 2\n${nodes.map((current) => render({ node: current, depth: 0 })).join('')}`

const child = ({ name, value }: { readonly name: string; readonly value: Value }): Node =>
  node({ name, args: [value] })
const block = ({
  name,
  children,
}: {
  readonly name: string
  readonly children: readonly Node[]
}): Node => node({ name, children })
const optionalChild = ({
  name,
  value,
}: {
  readonly name: string
  readonly value: string | undefined
}): Node[] => (value === undefined ? [] : [child({ name, value })])

const Text = Schema.NonEmptyString

const SubjectId = Schema.String.pipe(
  Schema.refine(
    (s): s is string =>
      s.length <= 512 &&
      /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(s) === true &&
      s.endsWith('/') === false &&
      s.split('/').some((part) => part === '..') === false,
    { message: 'invalid st subject ID' },
  ),
  Schema.brand('SubjectId'),
)

const LocalId = Schema.String.pipe(
  Schema.refine((s): s is string => s.length > 0 && s.length <= 160 && /[\s/]/u.test(s) === false, {
    message: 'invalid local ID',
  }),
  Schema.brand('LocalId'),
)

const MissionId = Schema.String.pipe(
  Schema.refine(
    (s): s is string =>
      s.length > 0 &&
      s.length <= 160 &&
      s.startsWith('/') === false &&
      s.endsWith('/') === false &&
      s.includes('//') === false &&
      /\s/u.test(s) === false,
    { message: 'invalid mission ID' },
  ),
  Schema.brand('MissionId'),
)

const durationScale = { ms: 1n, s: 1000n, m: 60000n, h: 3600000n, d: 86400000n } as const
const maxDurationMillis = 18446744073709551615n

const Duration = Schema.String.pipe(
  Schema.refine(
    (s): s is string => {
      const match = /^(\d+)(ms|s|m|h|d)$/u.exec(s)
      if (match === null) return false
      const millis = BigInt(match[1]!) * durationScale[match[2] as keyof typeof durationScale]
      return millis > 0n && millis <= maxDurationMillis
    },
    { message: 'invalid positive st duration' },
  ),
  Schema.brand('Duration'),
)

const UtcAnchor = Schema.String.pipe(
  Schema.refine(
    (s): s is string =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(s) === true &&
      Number.isFinite(Date.parse(s)) === true &&
      new Date(s).toISOString().slice(0, 19) === s.slice(0, 19),
    { message: 'invalid UTC anchor' },
  ),
  Schema.brand('UtcAnchor'),
)

const Revision = Schema.String.pipe(
  Schema.refine(
    (s): s is string =>
      /^[^@\s/][^@\s]*@[a-fA-F0-9]{64}$/u.test(s) === true &&
      s.slice(0, s.lastIndexOf('@')).endsWith('/') === false,
    { message: 'expected mission@64-hex revision' },
  ),
  Schema.brand('Revision'),
)

const Restart = Schema.Literals(['never', 'always'])
const Env = Schema.Record(Schema.String, Schema.String)
const Authority = Schema.Array(Schema.Struct({ verb: Text, pattern: Text }))

const AgentTask = Schema.Struct({
  id: LocalId,
  host: Schema.optionalKey(Text),
  workspace: Schema.optionalKey(Text),
  command: Schema.optionalKey(Text),
  argv: Schema.optionalKey(Schema.Array(Text)),
  restart: Schema.optionalKey(Restart),
}).pipe(
  Schema.refine(
    (t): t is typeof t => Number(t.command !== undefined) + Number(t.argv !== undefined) === 1,
    {
      message: 'task needs exactly one launch form',
    },
  ),
)

const RenderOperation = Schema.Struct({
  kind: Schema.Literals(['copy', 'file', 'json-upsert']),
  destination: Text,
  content: Text,
  executable: Schema.optionalKey(Schema.Boolean),
  arrays: Schema.optionalKey(Schema.Literals(['replace', 'union'])),
})

/** OMP harness selection for a seat. */
export const OmpSchema = Schema.Struct({
  kind: Schema.Literal('omp'),
  model: Text,
  effort: Schema.Literals(['low', 'medium', 'high']),
}).annotate({ identifier: 'St.Omp' })

const AgentSchemaFields = Schema.Struct({
  id: SubjectId,
  identity: Schema.optionalKey(Text),
  name: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  host: Schema.optionalKey(Text),
  workspace: Schema.optionalKey(Text),
  create: Schema.optionalKey(Schema.Boolean),
  checkout: Schema.optionalKey(
    Schema.Struct({
      repository: Text,
      base: Text,
      branch: Text,
      removeAtRunEnd: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  under: Schema.optionalKey(
    Schema.Array(Schema.Struct({ target: Text, reason: Schema.optionalKey(Text) })),
  ),
  restart: Schema.optionalKey(Restart),
  rollout: Schema.optionalKey(Schema.Literal('manual')),
  shutdownTimeout: Schema.optionalKey(Duration),
  command: Schema.optionalKey(Text),
  argv: Schema.optionalKey(Schema.Array(Text)),
  env: Schema.optionalKey(Env),
  render: Schema.optionalKey(Schema.Array(RenderOperation)),
  harness: Schema.optionalKey(OmpSchema),
  freshContext: Schema.optionalKey(Schema.Literal(true)),
  handlesFaults: Schema.optionalKey(Schema.Literal(true)),
  missionAuthority: Schema.optionalKey(Authority),
  queueAuthority: Schema.optionalKey(Authority),
  seatAuthority: Schema.optionalKey(Authority),
  pty: Schema.optionalKey(Schema.Array(AgentTask)),
  exec: Schema.optionalKey(Schema.Array(AgentTask)),
})

const isValidAgent = (a: typeof AgentSchemaFields.Type): boolean =>
  (a.checkout === undefined || a.workspace !== undefined) &&
  (a.create === undefined || a.workspace !== undefined) &&
  (a.name === undefined || a.name.length <= 160) &&
  (a.description === undefined || a.description.length <= 1000) &&
  Number(a.command !== undefined) +
    Number(a.argv !== undefined) +
    Number(a.harness !== undefined) <=
    1 &&
  (a.env === undefined ||
    Object.keys(a.env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) === true)) &&
  (a.render === undefined || a.render.length > 0) &&
  [a.missionAuthority, a.queueAuthority, a.seatAuthority].every(
    (rules) => rules === undefined || rules.length > 0,
  )

/** A durable st agent seat declaration. */
export const AgentSchema = AgentSchemaFields.pipe(
  Schema.refine((a): a is typeof a => isValidAgent(a), { message: 'invalid agent declaration' }),
  Schema.annotate({ identifier: 'St.Agent' }),
)

const GateName = Text.pipe(Schema.refine((s): s is string => new TextEncoder().encode(s).length <= 160))
const validName = (s: string, full: boolean): boolean =>
  s.length > 0 && s.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(s) &&
  s.split('/').every((part) => part !== '' && part !== '..') && (!full || s.includes('/'))
const validSubject = (s: string): boolean => {
  if (/^\$\{[A-Za-z0-9_.]*\}$/u.test(s)) return true
  const concrete = s.replace(/\$\{[^}]*\}/gu, 'x')
  if (concrete.includes('${')) return false
  if (concrete.startsWith('file/')) {
    const colon = concrete.indexOf(':')
    const host = concrete.slice(5, colon)
    const path = concrete.slice(colon + 1)
    return colon > 5 && validName(host, false) && path.startsWith('/') &&
      !path.includes('/../') && !path.endsWith('/..')
  }
  return validName(concrete, true)
}
const FullSubject = Text.pipe(Schema.refine((s): s is string => validSubject(s)))
const Goals = Schema.Array(Text).pipe(Schema.refine((goals): goals is typeof goals => goals.length <= 3))
const NonNegativeDuration = Schema.Union([Duration, Schema.Literals(['0ms', '0s', '0m', '0h', '0d'])])

const reservedGateEnvNames: Readonly<Record<string, true>> = {
  ST_MISSION: true, ST_MISSION_REVISION: true, ST_MISSION_RUN: true,
  ST_RUN_GENERATION: true, ST_ROOT_MISSION_RUN: true, ST_ROOT_MISSION_RUN_ID: true,
  ST_WORKSPACE: true, ST_REQUESTER: true, ST_STEP: true, ST_STEP_RUN: true,
  ST_ATTEMPT: true, ST_ASSIGNEE: true, ST_PARENT_STEP_RUN: true, ST_GATE: true,
  ST_AGENT: true, ST_LOOP_ROUND: true, ST_LOOP_FEEDBACK: true, ST_LOOP_ITEM_ID: true,
  ST_CANDIDATE_INDEX: true, ST3_SUBJECT: true,
}

const DocumentHash = Schema.String.pipe(Schema.refine((s): s is string => /^[0-9a-fA-F]{64}$/u.test(s)))
/** A document gate may wait for a name or an immutable version. */
export const DocumentReferenceSchema = Text.pipe(Schema.refine((s): s is string => {
  if (!s.startsWith('doc/')) return false
  if (s.includes('${')) return true
  const at = s.lastIndexOf('@')
  const name = at < 0 ? s : s.slice(0, at)
  return name.length > 4 && !name.includes('..') && !name.endsWith('/') &&
    (at < 0 || /^[0-9a-fA-F]{64}$/u.test(s.slice(at + 1)))
})).annotate({ identifier: 'St.DocumentReference' })

/** Step documents always pin an exact immutable version. */
export const PinnedDocumentReferenceSchema = DocumentReferenceSchema.pipe(
  Schema.refine((s): s is string => !s.includes('${') && /@[0-9a-fA-F]{64}$/u.test(s)),
).annotate({ identifier: 'St.PinnedDocumentReference' })

/** Graph predicates and built-in mechanical gates accepted by st. */
export const GateSchema = Schema.Union([
  Schema.Struct({ name: GateName, kind: Schema.Literal('exists'), subject: FullSubject }),
  Schema.Struct({ name: GateName, kind: Schema.Literal('document'), subject: DocumentReferenceSchema }),
  Schema.Struct({ name: GateName, kind: Schema.Literal('empty'), subject: FullSubject.pipe(Schema.refine((s): s is string => s.startsWith('mission-run/'))) }),
  Schema.Struct({ name: GateName, kind: Schema.Literals(['has', 'lacks']), subject: FullSubject.pipe(Schema.refine((s): s is string => /^(file|doc|message)\//u.test(s))), text: Schema.String }),
  Schema.Struct({
    name: GateName, kind: Schema.Literal('field'),
    path: Text.pipe(Schema.refine((s): s is string => /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(s))),
    subject: FullSubject, operator: Schema.Literals(['is', 'starts-with', 'contains']),
    value: Schema.Union([Schema.String, Schema.Finite.pipe(Schema.refine((n): n is number =>
      !Number.isInteger(n) || Number.isSafeInteger(n))), Schema.Boolean]),
  }),
  Schema.Struct({
    name: GateName, kind: Schema.Literal('merged'),
    locator: Text.pipe(Schema.refine((s): s is string => s.includes('${') || /^[^/#]+\/[^/#]+#[1-9][0-9]*$/u.test(s))),
    host: Schema.optionalKey(Text), workspace: Schema.optionalKey(Text), timeLimit: Schema.optionalKey(Duration),
  }),
  Schema.Struct({
    name: GateName, kind: Schema.Literal('ci-passed'), check: Text, repo: Text,
    ref: Schema.Union([Schema.Struct({ commit: Text }), Schema.Struct({ branch: Text })]),
    host: Schema.optionalKey(Text), workspace: Schema.optionalKey(Text), timeLimit: Schema.optionalKey(Duration),
  }),
  Schema.Struct({
    name: GateName, kind: Schema.Literal('exec'), command: Text, host: Text, workspace: Text,
    env: Schema.optionalKey(Env.pipe(Schema.refine((env): env is typeof env =>
      Object.keys(env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && reservedGateEnvNames[key] !== true)))),
    timeLimit: Schema.optionalKey(Duration),
  }),
]).annotate({ identifier: 'St.Gate' })

const Gates = Schema.Array(GateSchema).pipe(Schema.refine((gates): gates is typeof gates =>
  new Set(gates.map((g) => g.name)).size === gates.length))

/** Retry attempts include the initial attempt; zero backoff is allowed. */
export const RetrySchema = Schema.Struct({
  attempts: Schema.Int.pipe(Schema.refine((n): n is number => n >= 1 && n <= 100)),
  backoff: Schema.optionalKey(NonNegativeDuration),
}).annotate({ identifier: 'St.Retry' })

/** An agentless command a step runs. */
export const ExecSchema = Schema.Struct({
  id: LocalId,
  host: Text,
  workspace: Text,
  command: Text,
  restart: Restart,
}).annotate({ identifier: 'St.Exec' })

/** A dependency on another step reaching a state. */
export const DependsOnSchema = Schema.Struct({
  step: LocalId,
  state: Schema.Literals(['completed', 'failed', 'terminal']),
}).annotate({
  identifier: 'St.DependsOn',
})

/** A typed st resource. */
export const ResourceSchema = Schema.Struct({
  id: SubjectId,
  kind: Schema.Literals(['vcs.repository', 'filesystem.file', 'vcs.pull-request', 'vcs.ref']),
}).annotate({ identifier: 'St.Resource' })

/** A named binding to a previously stored immutable document. */
export const DocSchema = Schema.Struct({
  id: SubjectId, hash: DocumentHash,
}).annotate({ identifier: 'St.Doc' })

const UniqueFields = Schema.NonEmptyArray(Text).pipe(Schema.refine((fields): fields is typeof fields =>
  new Set(fields).size === fields.length))

/** A ref observer; st scopes its ID when declared within a mission run. */
export const ObserverSchema = Schema.Struct({
  id: SubjectId,
  resource: FullSubject.pipe(Schema.refine((s): s is string => s.startsWith('resource/'))),
  provider: Schema.Literal('github.ref'),
  locator: Text.pipe(Schema.refine((s): s is string => {
    const at = s.lastIndexOf('@')
    if (at < 0 || at === s.length - 1) return false
    const repository = s.slice(0, at)
    const slash = repository.indexOf('/')
    return slash > 0 && slash < repository.length - 1 && !repository.slice(slash + 1).includes('/')
  })),
  fields: Schema.NonEmptyArray(Schema.Literals(['head', 'ancestors'])).pipe(
    Schema.refine((fields): fields is typeof fields => new Set(fields).size === fields.length),
  ),
  every: Schema.optionalKey(Duration),
}).annotate({ identifier: 'St.Observer' })

/** A message subscription to changed ref fields, optionally filtered by a field predicate. */
export const SubscriptionSchema = Schema.Struct({
  id: SubjectId,
  observer: FullSubject.pipe(Schema.refine((s): s is string => s.startsWith('observer/'))),
  to: FullSubject,
  on: UniqueFields,
  delivery: Schema.Literal('message'),
  when: Schema.optionalKey(Schema.Struct({
    path: Text.pipe(Schema.refine((s): s is string => /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(s))),
    operator: Schema.Literals(['is', 'starts-with', 'contains']),
    value: Schema.Union([Schema.String, Schema.Finite.pipe(Schema.refine((n): n is number =>
      !Number.isInteger(n) || Number.isSafeInteger(n))), Schema.Boolean]),
  })),
}).annotate({ identifier: 'St.Subscription' })

const uniqueIds = (values: readonly { readonly id: string }[]): boolean =>
  new Set(values.map((value) => value.id)).size === values.length
const OwnedDeclarationFields = {
  resources: Schema.optionalKey(Schema.Array(ResourceSchema).pipe(Schema.refine((values): values is typeof values => uniqueIds(values)))),
  docs: Schema.optionalKey(Schema.Array(DocSchema).pipe(Schema.refine((values): values is typeof values => uniqueIds(values)))),
  observers: Schema.optionalKey(Schema.Array(ObserverSchema).pipe(Schema.refine((values): values is typeof values => uniqueIds(values)))),
  subscriptions: Schema.optionalKey(Schema.Array(SubscriptionSchema).pipe(Schema.refine((values): values is typeof values => uniqueIds(values)))),
}

/** One mission step. */
export const StepSchema = Schema.Struct({
  id: LocalId,
  ...OwnedDeclarationFields,
  documents: Schema.optionalKey(Schema.Array(PinnedDocumentReferenceSchema)),
  timeout: Schema.optionalKey(Duration),
  agentless: Schema.optionalKey(Schema.Literal(true)),
  assignedTo: Schema.optionalKey(SubjectId),
  dependsOn: Schema.optionalKey(Schema.NonEmptyArray(DependsOnSchema)),
  goals: Schema.optionalKey(Goals),
  exec: Schema.optionalKey(ExecSchema),
  gates: Schema.optionalKey(Gates),
  retry: Schema.optionalKey(RetrySchema),
}).pipe(
  Schema.refine(
    (s): s is typeof s => (s.agentless === true && s.assignedTo !== undefined) === false,
    {
      message: 'agentless and assigned-to conflict',
    },
  ),
  Schema.annotate({ identifier: 'St.Step' }),
)
/** All exhausted work, or an explicit completion frontier of normal steps. */
export const CompletionSchema = Schema.Union([
  Schema.Struct({ when: Schema.Literal('all-steps-exhausted') }),
  Schema.Struct({ dependsOn: Schema.NonEmptyArray(DependsOnSchema) }),
]).annotate({ identifier: 'St.Completion' })

const validGraph = (m: {
  readonly steps: readonly { readonly id: string; readonly dependsOn?: readonly typeof DependsOnSchema.Type[] }[]
  readonly finally?: readonly typeof StepSchema.Type[]
  readonly completion?: typeof CompletionSchema.Type
}): boolean => {
  const all = [...m.steps, ...(m.finally ?? [])]
  const ids = new Set(all.map((s) => s.id))
  return ids.size === all.length &&
    [m.steps, m.finally ?? []].every((phase) =>
      phase.every((s) => (s.dependsOn ?? []).every((d) => phase.some((target) => target.id === d.step)))) &&
    (m.completion === undefined || 'when' in m.completion ||
      m.completion.dependsOn.every((d) => m.steps.some((s) => s.id === d.step)))
}

/** The embedded mission for one sequential loop round. */
export const RoundSchema = Schema.Struct({
  ...OwnedDeclarationFields,
  completion: CompletionSchema,
  steps: Schema.Array(StepSchema),
  finally: Schema.optionalKey(Schema.NonEmptyArray(StepSchema)),
}).pipe(Schema.refine((m): m is typeof m => validGraph(m))).annotate({ identifier: 'St.Round' })

/** A bounded sequential loop, represented as an ordered mission graph node. */
export const LoopSchema = Schema.Struct({
  id: LocalId,
  timeout: Schema.optionalKey(Duration),
  dependsOn: Schema.optionalKey(Schema.NonEmptyArray(DependsOnSchema)),
  maxRounds: Schema.Int.pipe(Schema.refine((n): n is number => n >= 1 && n <= 100)),
  until: Schema.optionalKey(Schema.NonEmptyArray(GateSchema).pipe(Schema.refine((gates): gates is typeof gates =>
    new Set(gates.map((g) => g.name)).size === gates.length))),
  round: RoundSchema,
  onExhausted: Schema.optionalKey(Schema.Union([
    Schema.Struct({ outcome: Schema.Literal('succeed') }),
    Schema.Struct({ outcome: Schema.Literal('fail'), attention: Schema.optionalKey(Schema.Struct({
      title: Text.pipe(Schema.refine((s): s is string => s.trim().length > 0)),
      reviewer: FullSubject.pipe(Schema.refine((s): s is string => s.startsWith('person/'))),
      severity: Schema.Literals(['warning', 'error']),
    })) }),
  ])),
}).annotate({ identifier: 'St.Loop' })


/** The mission revision and workspace a schedule starts. */
export const WorkSchema = Schema.Struct({ mission: Revision, workspace: Text }).annotate({
  identifier: 'St.Work',
})

/** A recurring schedule with latest-only catch-up. */
export const ScheduleSchema = Schema.Struct({
  id: LocalId,
  host: Schema.Literal('local'),
  every: Duration,
  anchor: UtcAnchor,
  catchUp: Schema.Literal('latest'),
  work: WorkSchema,
}).annotate({ identifier: 'St.Schedule' })

/** A ready mission with unique steps whose dependencies exist. */
export const MissionSchema = Schema.Struct({
  id: MissionId,
  ...OwnedDeclarationFields,
  state: Schema.Literal('ready'),
  timeout: Schema.optionalKey(Duration),
  goals: Goals.pipe(Schema.refine((goals): goals is typeof goals => goals.length > 0)),
  gates: Schema.optionalKey(Gates),
  constraints: Schema.optionalKey(Schema.Array(Text)),
  steps: Schema.Array(Schema.Union([StepSchema, LoopSchema])),
  completion: Schema.optionalKey(CompletionSchema),
  finally: Schema.optionalKey(Schema.NonEmptyArray(StepSchema)),
  schedule: Schema.optionalKey(ScheduleSchema),
}).pipe(
  Schema.refine(
    (m): m is typeof m => validGraph(m),
    { message: 'mission needs unique graph nodes, existing dependencies and a normal completion frontier' },
  ),
  Schema.annotate({ identifier: 'St.Mission' }),
)


const decode = <S extends Schema.ConstraintDecoder<unknown>>({
  schema,
  input,
}: {
  readonly schema: S
  readonly input: unknown
}): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)

/** Decodes an OMP harness selection. */
export const omp = ({
  model,
  effort,
}: {
  readonly model: string
  readonly effort: 'low' | 'medium' | 'high'
}): typeof OmpSchema.Type => decode({ schema: OmpSchema, input: { kind: 'omp', model, effort } })

/** Decodes and renders a resource node. */
export const resource = (input: typeof ResourceSchema.Encoded): Node => {
  const r = decode({ schema: ResourceSchema, input })
  return node({
    name: 'resource',
    args: [r.id],
    children: [child({ name: 'kind', value: r.kind })],
  })
}

/** Decodes and renders a binding to an immutable document hash. */
export const doc = (input: typeof DocSchema.Encoded): Node => {
  const d = decode({ schema: DocSchema, input })
  return node({ name: 'doc', args: [d.id], children: [child({ name: 'hash', value: d.hash.toLowerCase() })] })
}

/** Decodes and renders a ref observer, including repeated selected fields. */
export const observer = (input: typeof ObserverSchema.Encoded): Node => {
  const o = decode({ schema: ObserverSchema, input })
  return node({ name: 'observer', args: [o.id], children: [
    child({ name: 'resource', value: o.resource }),
    child({ name: 'provider', value: o.provider }),
    child({ name: 'locator', value: o.locator }),
    ...o.fields.map((field) => child({ name: 'field', value: field })),
    ...optionalChild({ name: 'every', value: o.every }),
  ] })
}

/** Decodes and renders a message subscription to ref observations. */
export const subscription = (input: typeof SubscriptionSchema.Encoded): Node => {
  const s = decode({ schema: SubscriptionSchema, input })
  return node({ name: 'subscription', args: [s.id], children: [
    child({ name: 'observer', value: s.observer }),
    child({ name: 'to', value: s.to }),
    ...s.on.map((field) => child({ name: 'on', value: field })),
    ...(s.when === undefined ? [] : [block({ name: 'when', children: [
      node({ name: 'field', args: [s.when.path, s.when.operator, s.when.value] }),
    ] })]),
    child({ name: 'delivery', value: s.delivery }),
  ] })
}

const ownedDeclarationNodes = (input: {
  readonly resources?: readonly typeof ResourceSchema.Encoded[]
  readonly docs?: readonly typeof DocSchema.Encoded[]
  readonly observers?: readonly typeof ObserverSchema.Encoded[]
  readonly subscriptions?: readonly typeof SubscriptionSchema.Encoded[]
}): Node[] => [
  ...(input.resources ?? []).map(resource), ...(input.docs ?? []).map(doc),
  ...(input.observers ?? []).map(observer), ...(input.subscriptions ?? []).map(subscription),
]

/** Decodes and renders a schedule node. */
export const schedule = (input: typeof ScheduleSchema.Encoded): Node => {
  const s = decode({ schema: ScheduleSchema, input })
  return node({
    name: 'schedule',
    args: [s.id],
    children: [
      child({ name: 'host', value: s.host }),
      child({ name: 'every', value: s.every }),
      child({ name: 'anchor', value: s.anchor }),
      child({ name: 'catch-up', value: s.catchUp }),
      block({
        name: 'work',
        children: [
          child({ name: 'mission', value: s.work.mission }),
          child({ name: 'workspace', value: s.work.workspace }),
        ],
      }),
    ],
  })
}

/** Decodes and lowers a gate without changing its predicate or built-in kind. */
export const gate = (input: typeof GateSchema.Encoded): Node => {
  const g = decode({ schema: GateSchema, input })
  let predicate: Node
  switch (g.kind) {
    case 'exists': case 'empty': case 'document':
      predicate = child({ name: g.kind, value: g.subject }); break
    case 'has': case 'lacks':
      predicate = node({ name: g.kind, args: [g.subject, g.text] }); break
    case 'field':
      predicate = node({ name: 'field', args: [g.path, g.subject, g.operator, g.value] }); break
    case 'merged':
      predicate = child({ name: 'merged', value: g.locator }); break
    case 'ci-passed':
      predicate = node({ name: 'ci-passed', args: [g.check], props: { repo: g.repo, ...g.ref } }); break
    case 'exec':
      predicate = child({ name: 'exec', value: g.command }); break
  }
  return node({ name: 'gate', args: [g.name], children: [
    predicate,
    ...(g.kind === 'merged' || g.kind === 'ci-passed' || g.kind === 'exec' ? [
      ...optionalChild({ name: 'host', value: g.host }),
      ...optionalChild({ name: 'workspace', value: g.workspace }),
      ...optionalChild({ name: 'time-limit', value: g.timeLimit }),
      ...(g.kind === 'exec' && g.env !== undefined ? [block({ name: 'env', children:
        Object.entries(g.env).toSorted(([a], [b]) => a.localeCompare(b, 'en')).map(([name, value]) => child({ name, value })),
      })] : []),
    ] : []),
  ] })
}

/** Decodes and renders a step node. */
const lowerStep = (input: typeof StepSchema.Encoded): Node => {
  const s = decode({ schema: StepSchema, input })
  const children: Node[] = []
  if (s.agentless === true) children.push(node({ name: 'agentless' }))
  if (s.assignedTo !== undefined) children.push(child({ name: 'assigned-to', value: s.assignedTo }))
  if (s.dependsOn !== undefined) {
    children.push(
      block({
        name: 'depends-on',
        children: s.dependsOn.map((d) => node({ name: 'step', args: [d.step, d.state] })),
      }),
    )
  }
  for (const goal of s.goals ?? []) children.push(child({ name: 'goal', value: goal }))
  for (const document of s.documents ?? []) children.push(child({ name: 'document', value: document }))
  children.push(...ownedDeclarationNodes(s))
  if (s.exec !== undefined) {
    children.push(
      node({
        name: 'exec',
        args: [s.exec.id],
        children: [
          child({ name: 'host', value: s.exec.host }),
          child({ name: 'workspace', value: s.exec.workspace }),
          child({ name: 'command', value: s.exec.command }),
          child({ name: 'restart', value: s.exec.restart }),
        ],
      }),
    )
  }
  children.push(...(s.gates ?? []).map(gate))
  if (s.retry !== undefined) children.push(block({ name: 'retry', children: [
    child({ name: 'attempts', value: s.retry.attempts }),
    ...optionalChild({ name: 'backoff', value: s.retry.backoff }),
  ] }))
  return node({
    name: 'step',
    args: [s.id],
    props: s.timeout === undefined ? {} : { timeout: s.timeout },
    children,
  })
}

/** A resolved agent reference. Tree-module refs (#1628) require their tree root to resolve an ID. */
export interface AgentRef {
  readonly kind: 'agent'
  readonly id: string
}

const stepBrand = Symbol('StepHandle')
const dependencyBrand = Symbol('StepDependency')

/** A renderable step with explicit identity and, optionally, a literal mission scope. */
export interface StepHandle<TMission extends string = string> extends Node {
  readonly [stepBrand]: true
  readonly missionId?: TMission
  readonly id: string
}

export interface StepDependency<TMission extends string = string> {
  readonly [dependencyBrand]: true
  readonly handle: StepHandle<TMission>
  readonly state: typeof DependsOnSchema.Encoded.state
}

type StepDependencyInput<TMission extends string> = typeof DependsOnSchema.Encoded | StepDependency<NoInfer<TMission>>
type StepInput<TMission extends string> = Omit<typeof StepSchema.Encoded, 'assignedTo' | 'dependsOn'> & {
  readonly missionId?: TMission
  readonly assignedTo?: string | AgentRef
  readonly dependsOn?: readonly [StepDependencyInput<TMission>, ...StepDependencyInput<TMission>[]]
}
type MissionInput<TMission extends string> = Omit<typeof MissionSchema.Encoded, 'id' | 'steps' | 'finally'> & {
  readonly id: TMission
  readonly steps: readonly ((typeof StepSchema.Encoded | typeof LoopSchema.Encoded) & { readonly [stepBrand]?: never } | StepHandle<NoInfer<TMission>>)[]
  readonly finally?: readonly (typeof StepSchema.Encoded & { readonly [stepBrand]?: never } | StepHandle<NoInfer<TMission>>)[]
}

const stepData = new WeakMap<object, {
  readonly missionId?: string
  readonly wire: typeof StepSchema.Encoded
  readonly dependencies: readonly StepDependency[]
}>()
const stepOwners = new WeakMap<object, string>()
const isStepHandle = (value: object): value is StepHandle => stepData.has(value)

const dependency = <TMission extends string>(
  handle: StepHandle<TMission>, state: StepDependency['state'],
): StepDependency<TMission> => ({ [dependencyBrand]: true, handle, state })
export const completed = <TMission extends string>(handle: StepHandle<TMission>): StepDependency<TMission> =>
  dependency(handle, 'completed')
export const failed = <TMission extends string>(handle: StepHandle<TMission>): StepDependency<TMission> =>
  dependency(handle, 'failed')
export const terminal = <TMission extends string>(handle: StepHandle<TMission>): StepDependency<TMission> =>
  dependency(handle, 'terminal')

/** `missionId` gives static scope checking; unscoped/plain-data steps are checked when assembled. */
export const step = <const TMission extends string = never>(input: StepInput<TMission>): StepHandle<TMission> => {
  const { missionId, assignedTo, dependsOn, ...rest } = input
  const dependencies: readonly StepDependency<TMission>[] =
    dependsOn?.filter((d): d is StepDependency<TMission> => dependencyBrand in d) ?? []
  const wire = decode({ schema: StepSchema, input: {
    ...rest,
    ...(assignedTo === undefined ? {} : {
      assignedTo: typeof assignedTo === 'string' ? assignedTo :
        `agent/${decode({ schema: Schema.Struct({ kind: Schema.Literal('agent'), id: SubjectId }), input: assignedTo }).id}`,
    }),
    ...(dependsOn === undefined ? {} : {
      dependsOn: dependsOn.map((d) => dependencyBrand in d ? { step: d.handle.id, state: d.state } : d),
    }),
  } })
  const rendered = lowerStep(wire)
  const handle = { ...rendered, [stepBrand]: true as const, ...(missionId === undefined ? {} : { missionId }), id: input.id }
  stepData.set(handle, { ...(missionId === undefined ? {} : { missionId }), wire, dependencies })
  return handle
}

const dependenciesNode = (dependencies: readonly typeof DependsOnSchema.Encoded[]): Node =>
  block({ name: 'depends-on', children: dependencies.map((d) => node({ name: 'step', args: [d.step, d.state] })) })

/** Lowers an explicit completion frontier. */
export const completion = (input: typeof CompletionSchema.Encoded): Node => {
  const c = decode({ schema: CompletionSchema, input })
  return block({ name: 'completion', children: 'when' in c ?
    [child({ name: 'when', value: c.when })] : [dependenciesNode(c.dependsOn)] })
}

/** Lowers a loop and its explicitly completed round mission. */
export const loop = (input: typeof LoopSchema.Encoded): Node => {
  const l = decode({ schema: LoopSchema, input })
  return node({ name: 'loop', args: [l.id], props: l.timeout === undefined ? {} : { timeout: l.timeout }, children: [
    ...(l.dependsOn === undefined ? [] : [dependenciesNode(l.dependsOn)]),
    child({ name: 'max-rounds', value: l.maxRounds }),
    ...(l.until === undefined ? [] : [block({ name: 'until', children: l.until.map(gate) })]),
    block({ name: 'round', children: [
      completion(l.round.completion), ...l.round.steps.map(lowerStep),
      ...ownedDeclarationNodes(l.round),
      ...(l.round.finally === undefined ? [] : [block({ name: 'finally', children: l.round.finally.map(lowerStep) })]),
    ] }),
    ...(l.onExhausted === undefined ? [] : [block({ name: 'on-exhausted', children: [
      node({ name: l.onExhausted.outcome }),
      ...(l.onExhausted.outcome === 'fail' && l.onExhausted.attention !== undefined ? [
        node({ name: 'attention', args: [l.onExhausted.attention.title], children: [
          child({ name: 'reviewer', value: l.onExhausted.attention.reviewer }),
          child({ name: 'severity', value: l.onExhausted.attention.severity }),
        ] }),
      ] : []),
    ] })]),
  ] })
}

/** Decodes and renders a mission node with its schedule and steps. */
export const mission = <const TMission extends string>(input: MissionInput<TMission>): Node => {
  const allHandles = [...input.steps, ...(input.finally ?? [])].filter(isStepHandle)
  for (const handle of allHandles) {
    const data = stepData.get(handle)!
    if (data.missionId !== undefined && data.missionId !== input.id) {
      throw new TypeError(`Step ${data.wire.id} belongs to mission ${data.missionId}, not ${input.id}`)
    }
    const owner = stepOwners.get(handle)
    if (owner !== undefined && owner !== input.id) {
      throw new TypeError(`Step ${data.wire.id} already belongs to mission ${owner}`)
    }
    const normalPhase: readonly object[] = input.steps
    const phase: readonly object[] = normalPhase.includes(handle) ? input.steps : input.finally ?? []
    for (const dependency of data.dependencies) {
      if (!phase.includes(dependency.handle)) {
        throw new TypeError(`Dependency ${dependency.handle.id} is not a handle in the same mission phase`)
      }
    }
  }
  const m = decode({ schema: MissionSchema, input: {
    ...input,
    steps: input.steps.map((s) => isStepHandle(s) ? stepData.get(s)!.wire : s),
    ...(input.finally === undefined ? {} : {
      finally: input.finally.map((s) => isStepHandle(s) ? stepData.get(s)!.wire : s),
    }),
  } })
  for (const handle of allHandles) stepOwners.set(handle, input.id)
  return node({
    name: 'mission',
    args: [m.id],
    props: { state: m.state, ...(m.timeout === undefined ? {} : { timeout: m.timeout }) },
    children: [
      ...m.goals.map((goal) => child({ name: 'goal', value: goal })),
      ...(m.gates ?? []).map(gate),
      ...(m.constraints ?? []).map((constraint) =>
        child({ name: 'constraint', value: constraint }),
      ),
      ...ownedDeclarationNodes(m),
      ...(m.schedule === undefined ? [] : [schedule(m.schedule)]),
      ...(m.completion === undefined ? [] : [completion(m.completion)]),
      ...m.steps.map((s) => 'maxRounds' in s ? loop(s) : lowerStep(s)),
      ...(m.finally === undefined ? [] : [block({ name: 'finally', children: m.finally.map(lowerStep) })]),
    ],
  })
}

const authorityKeys = ['missionAuthority', 'queueAuthority', 'seatAuthority'] as const
const kebab = (key: string): string => key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)

const taskNode = ({
  kind,
  task,
}: {
  readonly kind: 'pty' | 'exec'
  readonly task: typeof AgentTask.Type
}): Node =>
  node({
    name: kind,
    args: [task.id],
    children: [
      ...optionalChild({ name: 'host', value: task.host }),
      ...optionalChild({ name: 'workspace', value: task.workspace }),
      ...optionalChild({ name: 'command', value: task.command }),
      ...(task.argv === undefined ? [] : [node({ name: 'argv', args: task.argv })]),
      ...optionalChild({ name: 'restart', value: task.restart }),
    ],
  })

/** Decodes and renders an agent seat node. */
export const agent = (input: typeof AgentSchema.Encoded): Node => {
  const a = decode({ schema: AgentSchema, input })
  const children: Node[] = [
    ...optionalChild({ name: 'identity', value: a.identity }),
    ...optionalChild({ name: 'name', value: a.name }),
    ...optionalChild({ name: 'description', value: a.description }),
    ...optionalChild({ name: 'host', value: a.host }),
  ]
  if (a.workspace !== undefined) {
    children.push(
      node({
        name: 'workspace',
        args: [a.workspace],
        props: a.create === undefined ? {} : { create: a.create },
      }),
    )
  }
  if (a.checkout !== undefined) {
    const checkout = a.checkout
    children.push(
      node({
        name: 'checkout',
        args: [checkout.repository],
        props: {
          base: checkout.base,
          branch: checkout.branch,
          ...(checkout.removeAtRunEnd === undefined
            ? {}
            : { 'remove-at-run-end': checkout.removeAtRunEnd }),
        },
      }),
    )
  }
  for (const under of a.under ?? []) {
    children.push(
      node({
        name: 'under',
        args: [under.target],
        props: under.reason === undefined ? {} : { reason: under.reason },
      }),
    )
  }
  children.push(
    ...optionalChild({ name: 'restart', value: a.restart }),
    ...optionalChild({ name: 'rollout', value: a.rollout }),
    ...optionalChild({ name: 'shutdown-timeout', value: a.shutdownTimeout }),
    ...optionalChild({ name: 'command', value: a.command }),
  )
  if (a.argv !== undefined) children.push(node({ name: 'argv', args: a.argv }))
  if (a.env !== undefined) {
    const entries = Object.entries(a.env).toSorted(([x], [y]) => x.localeCompare(y, 'en'))
    children.push(
      block({ name: 'env', children: entries.map(([key, value]) => child({ name: key, value })) }),
    )
  }
  if (a.render !== undefined) {
    const operations = a.render.map((op) =>
      node({
        name: op.kind,
        args: [op.destination, op.content],
        props: {
          ...(op.executable === undefined ? {} : { executable: op.executable }),
          ...(op.arrays === undefined ? {} : { arrays: op.arrays }),
        },
      }),
    )
    children.push(block({ name: 'render', children: operations }))
  }
  if (a.harness !== undefined) {
    children.push(
      node({
        name: 'harness',
        args: [a.harness.kind],
        children: [
          child({ name: 'model', value: a.harness.model }),
          child({ name: 'effort', value: a.harness.effort }),
        ],
      }),
    )
  }
  if (a.freshContext === true) children.push(node({ name: 'fresh-context' }))
  if (a.handlesFaults === true) children.push(node({ name: 'handles-faults' }))
  for (const key of authorityKeys) {
    const rules = a[key]
    if (rules !== undefined) {
      children.push(
        block({
          name: kebab(key),
          children: rules.map((rule) => child({ name: rule.verb, value: rule.pattern })),
        }),
      )
    }
  }
  for (const task of a.pty ?? []) children.push(taskNode({ kind: 'pty', task }))
  for (const task of a.exec ?? []) children.push(taskNode({ kind: 'exec', task }))
  return node({ name: 'agent', args: [a.id], children })
}

/** Genie output for a smalltalk KDL declaration file. */
export const smalltalkKdl = (nodes: readonly Node[]): GenieOutput<readonly Node[]> => ({
  data: nodes,
  stringify: () => emit(nodes),
  validate: () => {
    try {
      emit(nodes)
      return []
    } catch (cause) {
      return [
        {
          severity: 'error',
          packageName: '@overeng/genie-smalltalk',
          dependency: '',
          rule: 'smalltalk-kdl',
          message: cause instanceof Error ? cause.message : String(cause),
        },
      ]
    }
  },
})
