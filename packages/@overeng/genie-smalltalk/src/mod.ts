import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { Schema, SchemaGetter } from 'effect'

import type { GenieOutput } from '@overeng/genie'

import type {
  ChildMission,
  DocumentReference,
  InputHandle,
  ProductFields,
  ProductHandle,
  Products,
  ResourceInput,
  RunReference,
  TextInput,
  PullRequestReference,
  TextTemplate,
} from './run-values.ts'
import {
  isChildMission,
  isInputHandle,
  MissionInputSchema,
  ProductSchema,
  productSubjects,
  referenceText,
  templateReferences,
  templateText,
} from './run-values.ts'
export { childMission, doc, input, pr, product, runId, t } from './run-values.ts'
export type {
  ChildMission,
  ContextReference,
  DocumentReference,
  PullRequestReference,
  InputHandle,
  ProductHandle,
  Products,
  ResourceInput,
  TextInput,
  TextTemplate,
} from './run-values.ts'

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
  Schema.refine(
    (s): s is string =>
      s.length > 0 && Buffer.byteLength(s, 'utf8') <= 160 && /[\s/]/u.test(s) === false,
    {
      message: 'invalid local ID',
    },
  ),
  Schema.brand('LocalId'),
)

const MissionId = Schema.String.pipe(
  Schema.refine(
    (s): s is string =>
      s.length > 0 &&
      Buffer.byteLength(s, 'utf8') <= 160 &&
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
    (s): s is string => {
      const at = s.lastIndexOf('@')
      const id = s.slice(0, at).replace(/^mission\//u, '')
      return at > 0 && Schema.is(MissionId)(id) && /^[a-fA-F0-9]{64}$/u.test(s.slice(at + 1))
    },
    { message: 'expected mission@64-hex revision' },
  ),
  Schema.brand('Revision'),
)

const Restart = Schema.Literals(['never', 'always'])
const Env = Schema.Record(Schema.String, Schema.String)
const Authority = Schema.Array(Schema.Struct({ verb: Text, pattern: Text }))

const AgentTaskFields = Schema.Struct({
  id: LocalId,
  host: Schema.optionalKey(Text),
  workspace: Schema.optionalKey(Text),
  command: Schema.optionalKey(Text),
  argv: Schema.optionalKey(Schema.Array(Text)),
}).pipe(
  Schema.refine(
    (t): t is typeof t => Number(t.command !== undefined) + Number(t.argv !== undefined) === 1,
    {
      message: 'task needs exactly one launch form',
    },
  ),
)

const AgentTask = Schema.declare<typeof AgentTaskFields.Encoded>(
  (input): input is typeof AgentTaskFields.Encoded =>
    Schema.is(AgentTaskFields)(input) &&
    Reflect.ownKeys(input).every((key) => Object.hasOwn(AgentTaskFields.schema.fields, key)),
).annotate({ identifier: 'St.AgentTask' })

const RenderOperation = Schema.Struct({
  kind: Schema.Literals(['copy', 'file', 'json-upsert']),
  destination: Text,
  content: Text,
  executable: Schema.optionalKey(Schema.Boolean),
  arrays: Schema.optionalKey(Schema.Literals(['replace', 'union'])),
})

/** Resume a specific OMP transcript, or continue the latest session in its session directory. */
export const OmpResumeSchema = Schema.Union([
  Schema.Literal('latest'),
  Schema.Struct({ transcript: Text }),
]).annotate({ identifier: 'St.OmpResume' })

/** OMP harness selection for a seat. */
export const OmpSchema = Schema.Struct({
  kind: Schema.Literal('omp'),
  model: Text,
  effort: Schema.Literals(['low', 'medium', 'high']),
  resume: Schema.optionalKey(OmpResumeSchema),
}).annotate({ identifier: 'St.Omp' })

/** Codex harness selection with explicit model and effort routing. */
export const CodexSchema = Schema.Struct({
  kind: Schema.Literal('codex'),
  model: Text,
  effort: Text,
  args: Schema.optionalKey(Schema.Array(Text)),
  resume: Schema.optionalKey(Schema.Struct({ session: Text })),
}).annotate({ identifier: 'St.Codex' })

/**
 * The ID view of an imported agent declaration. Validation still checks the full
 * AgentSchema; this structural view keeps under references from recursively
 * expanding AgentSchema's inferred type and retains the original object.
 */
export interface AgentReference {
  readonly id: string
}

const isAgentReference = (input: unknown): input is AgentReference =>
  isAgentDeclaration(input) && input.id.includes('//') === false

/** An imported agent object, validated lazily without copying launch or kit metadata. */
export const AgentReferenceSchema = Schema.declare<AgentReference>(isAgentReference).annotate({
  identifier: 'St.AgentReference',
})

/** A person subject, distinct from the ID view of an imported agent declaration. */
export const PersonReferenceSchema = Schema.Struct({
  kind: Schema.Literal('person'),
  subject: Schema.String.pipe(
    Schema.refine(
      (subject): subject is `person/${string}` =>
        subject.startsWith('person/') &&
        subject.length > 'person/'.length &&
        subject.includes('//') === false &&
        Schema.is(SubjectId)(subject),
      { message: 'invalid person subject' },
    ),
  ),
}).annotate({ identifier: 'St.PersonReference' })

export type PersonReference = typeof PersonReferenceSchema.Type

/** References a named person; it is attribution, not a person credential. */
export const person = (subject: `person/${string}`): PersonReference =>
  decode({ schema: PersonReferenceSchema, input: { kind: 'person', subject } })

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
    Schema.Array(Schema.Struct({ target: AgentReferenceSchema, reason: Schema.optionalKey(Text) })),
  ),
  restart: Schema.optionalKey(Restart),
  rollout: Schema.optionalKey(Schema.Literal('manual')),
  shutdownTimeout: Schema.optionalKey(Duration),
  command: Schema.optionalKey(Text),
  argv: Schema.optionalKey(Schema.Array(Text)),
  env: Schema.optionalKey(Env),
  render: Schema.optionalKey(Schema.Array(RenderOperation)),
  harness: Schema.optionalKey(Schema.Union([OmpSchema, CodexSchema])),
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
  (a.harness?.kind !== 'codex' ||
    a.harness.resume === undefined ||
    a.env?.ST3_NATIVE_RESUME_SESSION === undefined ||
    a.env.ST3_NATIVE_RESUME_SESSION === a.harness.resume.session) &&
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

/**
 * A durable st agent declaration. Roots orchestrate and delegate heavy work to
 * harness subagents and missions; role and persona/runtime selectors are not authored.
 */
export const AgentSchema = AgentSchemaFields.pipe(
  Schema.refine((a): a is typeof a => isValidAgent(a), { message: 'invalid agent declaration' }),
  Schema.annotate({ identifier: 'St.Agent' }),
)

const isAgentDeclaration = Schema.is(AgentSchema)

const GateName = Text.pipe(Schema.refine((s): s is string => Buffer.byteLength(s, 'utf8') <= 160))
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
const FullSubject = Text.pipe(Schema.refine((s): s is string => validSubject(s)))
const Goal = Schema.Union([
  Text,
  Schema.NonEmptyArray(Text).pipe(
    Schema.refine((goals): goals is typeof goals => goals.length <= 3),
  ),
]).pipe(
  Schema.decodeTo(Schema.NonEmptyArray(Text), {
    decode: SchemaGetter.transform((value): readonly [string, ...string[]] =>
      typeof value === 'string' ? [value] : value,
    ),
    encode: SchemaGetter.transform((value) => value),
  }),
)
const NonNegativeDuration = Schema.Union([
  Duration,
  Schema.Literals(['0ms', '0s', '0m', '0h', '0d']),
])

const reservedGateEnvNames: Readonly<Record<string, true>> = {
  ST_MISSION: true,
  ST_MISSION_REVISION: true,
  ST_MISSION_RUN: true,
  ST_RUN_GENERATION: true,
  ST_ROOT_MISSION_RUN: true,
  ST_ROOT_MISSION_RUN_ID: true,
  ST_WORKSPACE: true,
  ST_REQUESTER: true,
  ST_STEP: true,
  ST_STEP_RUN: true,
  ST_ATTEMPT: true,
  ST_ASSIGNEE: true,
  ST_PARENT_STEP_RUN: true,
  ST_GATE: true,
  ST_AGENT: true,
  ST_LOOP_ROUND: true,
  ST_LOOP_FEEDBACK: true,
  ST_LOOP_ITEM_ID: true,
  ST_CANDIDATE_INDEX: true,
  ST3_SUBJECT: true,
}

const DocumentHash = Schema.String.pipe(
  Schema.refine((s): s is string => /^[0-9a-fA-F]{64}$/u.test(s)),
)
/** A document gate may wait for a name or an immutable version. */
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

/** Step documents always pin an exact immutable version. */
export const PinnedDocumentReferenceSchema = DocumentReferenceSchema.pipe(
  Schema.refine((s): s is string => !s.includes('${') && /@[0-9a-fA-F]{64}$/u.test(s)),
).annotate({ identifier: 'St.PinnedDocumentReference' })

/** A native graph-field predicate; the former nested field form is not accepted. */
export const FieldGateSchema = Schema.Struct({
  name: GateName,
  kind: Schema.Literal('field'),
  path: Text.pipe(
    Schema.refine((s): s is string =>
      /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(s),
    ),
  ),
  subject: FullSubject,
  operator: Schema.Literals(['is', 'starts-with', 'contains']),
  value: Schema.Union([
    Schema.String,
    Schema.Finite.pipe(
      Schema.refine((n): n is number => !Number.isInteger(n) || Number.isSafeInteger(n)),
    ),
    Schema.Boolean,
  ]),
}).annotate({ identifier: 'St.FieldGate' })

/**
 * A current-episode attributed review. Critical is the default: silence never passes.
 * TODO: authenticated-person-only decisions: https://github.com/compoundingtech/smalltalk/issues/2184
 */
export const HumanGateSchema = Schema.Struct({
  kind: Schema.Literal('human'),
  name: Text,
  reviewer: PersonReferenceSchema,
  mode: Schema.optionalKey(Schema.Literals(['approve', 'feedback'])),
  question: Schema.optionalKey(Text),
  review: Schema.optionalKey(
    Schema.Array(Text).pipe(
      Schema.refine(
        (targets): targets is typeof targets => new Set(targets).size === targets.length,
        {
          message: 'human gate review targets must be unique',
        },
      ),
    ),
  ),
}).annotate({ identifier: 'St.HumanGate' })

/** Graph predicates and built-in mechanical gates accepted by st. */
export const GateSchema = Schema.Union([
  Schema.Struct({ name: GateName, kind: Schema.Literal('exists'), subject: FullSubject }),
  Schema.Struct({
    name: GateName,
    kind: Schema.Literal('document'),
    subject: DocumentReferenceSchema,
  }),
  Schema.Struct({
    name: GateName,
    kind: Schema.Literal('empty'),
    subject: FullSubject.pipe(Schema.refine((s): s is string => s.startsWith('mission-run/'))),
  }),
  Schema.Struct({
    name: GateName,
    kind: Schema.Literals(['has', 'lacks']),
    subject: FullSubject.pipe(Schema.refine((s): s is string => /^(file|doc|message)\//u.test(s))),
    text: Schema.String,
  }),
  FieldGateSchema,
  Schema.Struct({
    name: GateName,
    kind: Schema.Literal('merged'),
    locator: Text.pipe(
      Schema.refine(
        (s): s is string => s.includes('${') || /^[^/#]+\/[^/#]+#[1-9][0-9]*$/u.test(s),
      ),
    ),
    host: Schema.optionalKey(Text),
    workspace: Schema.optionalKey(Text),
    timeLimit: Schema.optionalKey(Duration),
  }),
  Schema.Struct({
    name: GateName,
    kind: Schema.Literal('ci-passed'),
    check: Text,
    repo: Text,
    ref: Schema.Union([Schema.Struct({ commit: Text }), Schema.Struct({ branch: Text })]),
    host: Schema.optionalKey(Text),
    workspace: Schema.optionalKey(Text),
    timeLimit: Schema.optionalKey(Duration),
  }),
  Schema.Struct({
    name: GateName,
    kind: Schema.Literal('exec'),
    command: Text,
    host: Text,
    workspace: Text,
    env: Schema.optionalKey(
      Env.pipe(
        Schema.refine((env): env is typeof env =>
          Object.keys(env).every(
            (key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && reservedGateEnvNames[key] !== true,
          ),
        ),
      ),
    ),
    timeLimit: Schema.optionalKey(Duration),
  }),
  HumanGateSchema,
]).annotate({ identifier: 'St.Gate' })

const Gates = Schema.Array(GateSchema).pipe(
  Schema.refine(
    (gates): gates is typeof gates => new Set(gates.map((g) => g.name)).size === gates.length,
  ),
)

const withoutFeedback = (gates: readonly (typeof GateSchema.Type)[]): boolean =>
  gates.every((gate) => gate.kind !== 'human' || gate.mode !== 'feedback')

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
const DependencyItem = Schema.Union([LocalId, DependsOnSchema])
const Dependencies = Schema.Union([DependencyItem, Schema.NonEmptyArray(DependencyItem)]).pipe(
  Schema.decodeTo(Schema.NonEmptyArray(DependsOnSchema), {
    decode: SchemaGetter.transform((value) => {
      const values: readonly [typeof DependencyItem.Type, ...(typeof DependencyItem.Type)[]] =
        typeof value === 'string' || 'step' in value ? [value] : value
      const normalize = (dependency: typeof DependencyItem.Type): typeof DependsOnSchema.Type =>
        typeof dependency === 'string' ? { step: dependency, state: 'completed' } : dependency
      const [first, ...rest] = values
      return [normalize(first), ...rest.map(normalize)] as const
    }),
    encode: SchemaGetter.transform((value) => value),
  }),
)

/** A typed st resource. */
export const ResourceSchema = Schema.Struct({
  id: SubjectId,
  kind: Schema.Literals(['vcs.repository', 'filesystem.file', 'vcs.pull-request', 'vcs.ref']),
}).annotate({ identifier: 'St.Resource' })

/** A named binding to a previously stored immutable document. */
export const DocSchema = Schema.Struct({
  id: SubjectId,
  hash: DocumentHash,
}).annotate({ identifier: 'St.Doc' })

const UniqueFields = Schema.NonEmptyArray(Text).pipe(
  Schema.refine((fields): fields is typeof fields => new Set(fields).size === fields.length),
)

/** A ref observer; st scopes its ID when declared within a mission run. */
export const ObserverSchema = Schema.Struct({
  id: SubjectId,
  resource: FullSubject.pipe(Schema.refine((s): s is string => s.startsWith('resource/'))),
  provider: Schema.Literal('github.ref'),
  locator: Text.pipe(
    Schema.refine((s): s is string => {
      const at = s.lastIndexOf('@')
      if (at < 0 || at === s.length - 1) return false
      const repository = s.slice(0, at)
      const slash = repository.indexOf('/')
      return (
        slash > 0 && slash < repository.length - 1 && !repository.slice(slash + 1).includes('/')
      )
    }),
  ),
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
  when: Schema.optionalKey(
    Schema.Struct({
      path: Text.pipe(
        Schema.refine((s): s is string =>
          /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(s),
        ),
      ),
      operator: Schema.Literals(['is', 'starts-with', 'contains']),
      value: Schema.Union([
        Schema.String,
        Schema.Finite.pipe(
          Schema.refine((n): n is number => !Number.isInteger(n) || Number.isSafeInteger(n)),
        ),
        Schema.Boolean,
      ]),
    }),
  ),
}).annotate({ identifier: 'St.Subscription' })

const uniqueIds = (values: readonly { readonly id: string }[]): boolean =>
  new Set(values.map((value) => value.id)).size === values.length
const OwnedDeclarationFields = {
  resources: Schema.optionalKey(
    Schema.Array(ResourceSchema).pipe(
      Schema.refine((values): values is typeof values => uniqueIds(values)),
    ),
  ),
  docs: Schema.optionalKey(
    Schema.Array(DocSchema).pipe(
      Schema.refine((values): values is typeof values => uniqueIds(values)),
    ),
  ),
  observers: Schema.optionalKey(
    Schema.Array(ObserverSchema).pipe(
      Schema.refine((values): values is typeof values => uniqueIds(values)),
    ),
  ),
  subscriptions: Schema.optionalKey(
    Schema.Array(SubscriptionSchema).pipe(
      Schema.refine((values): values is typeof values => uniqueIds(values)),
    ),
  ),
}

const UsedMissionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('revision'), revision: Revision }),
  Schema.Struct({ kind: Schema.Literal('output'), outputOf: LocalId }),
]).annotate({ identifier: 'St.UsedMission' })

/** One mission step. */
export const StepSchema = Schema.Struct({
  id: LocalId,
  ...OwnedDeclarationFields,
  documents: Schema.optionalKey(Schema.Array(PinnedDocumentReferenceSchema)),
  timeout: Schema.optionalKey(Duration),
  agentless: Schema.optionalKey(Schema.Literal(true)),
  assignedTo: Schema.optionalKey(Schema.Union([AgentReferenceSchema, PersonReferenceSchema])),
  dependsOn: Schema.optionalKey(Dependencies),
  goal: Schema.optionalKey(Goal),
  exec: Schema.optionalKey(ExecSchema),
  gates: Schema.optionalKey(Gates),
  retry: Schema.optionalKey(RetrySchema),
  produces: Schema.optionalKey(
    Schema.NonEmptyArray(ProductSchema).pipe(
      Schema.refine(
        (values): values is typeof values =>
          values.every((value) => validSubject(value.subject)) &&
          new Set(values.map((value) => value.subject)).size === values.length,
      ),
    ),
  ),
  producesMission: Schema.optionalKey(MissionId),
  usesMission: Schema.optionalKey(UsedMissionSchema),
}).pipe(
  Schema.refine(
    (s): s is typeof s => (s.agentless === true && s.assignedTo !== undefined) === false,
    {
      message: 'agentless and assigned-to conflict',
    },
  ),
  Schema.refine(
    (s): s is typeof s => s.producesMission === undefined || s.usesMission === undefined,
    { message: 'a step cannot both produce and use a mission' },
  ),
  Schema.refine((s): s is typeof s => s.agentless !== true || withoutFeedback(s.gates ?? []), {
    message: 'feedback human gates require a worker step',
  }),
  Schema.annotate({ identifier: 'St.Step' }),
)
/** All exhausted work, or an explicit completion frontier of normal steps. */
export const CompletionSchema = Schema.Union([
  Schema.Struct({ when: Schema.Literal('all-steps-exhausted') }),
  Schema.Struct({ dependsOn: Dependencies }),
]).annotate({ identifier: 'St.Completion' })

const validGraph = (m: {
  readonly steps: readonly {
    readonly id: string
    readonly dependsOn?: readonly (typeof DependsOnSchema.Type)[]
    readonly producesMission?: string
    readonly usesMission?: typeof UsedMissionSchema.Type
  }[]
  readonly finally?: readonly (typeof StepSchema.Type)[]
  readonly completion?: typeof CompletionSchema.Type
}): boolean => {
  const all = [...m.steps, ...(m.finally ?? [])]
  const ids = new Set(all.map((s) => s.id))
  return (
    ids.size === all.length &&
    [m.steps, m.finally ?? []].every((phase) =>
      phase.every((s) => {
        const used = s.usesMission
        return (
          (s.dependsOn ?? []).every((d) => phase.some((target) => target.id === d.step)) &&
          (used?.kind !== 'output' ||
            (phase.some(
              (target) => target.id === used.outputOf && target.producesMission !== undefined,
            ) &&
              (s.dependsOn ?? []).some(
                (dependency) =>
                  dependency.step === used.outputOf && dependency.state === 'completed',
              )))
        )
      }),
    ) &&
    (m.completion === undefined ||
      'when' in m.completion ||
      m.completion.dependsOn.every((d) => m.steps.some((s) => s.id === d.step)))
  )
}

/** The embedded mission for one sequential loop round. */
export const RoundSchema = Schema.Struct({
  ...OwnedDeclarationFields,
  completion: CompletionSchema,
  steps: Schema.Array(StepSchema),
  finally: Schema.optionalKey(Schema.NonEmptyArray(StepSchema)),
})
  .pipe(Schema.refine((m): m is typeof m => validGraph(m)))
  .annotate({ identifier: 'St.Round' })

/** A bounded sequential loop, represented as an ordered mission graph node. */
export const LoopSchema = Schema.Struct({
  id: LocalId,
  timeout: Schema.optionalKey(Duration),
  dependsOn: Schema.optionalKey(Dependencies),
  maxRounds: Schema.Int.pipe(Schema.refine((n): n is number => n >= 1 && n <= 100)),
  until: Schema.optionalKey(
    Schema.NonEmptyArray(GateSchema).pipe(
      Schema.refine(
        (gates): gates is typeof gates => new Set(gates.map((g) => g.name)).size === gates.length,
      ),
      Schema.refine((gates): gates is typeof gates => withoutFeedback(gates), {
        message: 'feedback-gate-needs-step',
      }),
    ),
  ),
  round: RoundSchema,
  onExhausted: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ outcome: Schema.Literal('succeed') }),
      Schema.Struct({
        outcome: Schema.Literal('fail'),
        attention: Schema.optionalKey(
          Schema.Struct({
            title: Text.pipe(Schema.refine((s): s is string => s.trim().length > 0)),
            reviewer: PersonReferenceSchema,
            severity: Schema.Literals(['warning', 'error']),
          }),
        ),
      }),
    ]),
  ),
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

/**
 * Reference an imported agent declaration without copying its launch configuration.
 * Native st reports only to agents; people must be reached through their own agent.
 * Kit metadata on the declaration is not part of the reference.
 */
export const ReportToSchema = Schema.declare<typeof AgentSchema.Encoded>(isAgentDeclaration).pipe(
  Schema.refine((a): a is typeof a => a.id.includes('//') === false, {
    message: 'report-to agent ID must not contain empty path segments',
  }),
  Schema.annotate({ identifier: 'St.ReportTo' }),
)

/** A ready mission with required reporting and unique graph nodes. */
export const MissionSchema = Schema.Struct({
  id: MissionId,
  inputs: Schema.optionalKey(
    Schema.Array(MissionInputSchema).pipe(
      Schema.refine(
        (values): values is typeof values =>
          new Set(values.map((value) => value.name)).size === values.length,
      ),
    ),
  ),
  ...OwnedDeclarationFields,
  state: Schema.Literal('ready'),
  reportTo: ReportToSchema,
  assignedTo: Schema.optionalKey(Schema.Union([AgentReferenceSchema, PersonReferenceSchema])),
  timeout: Schema.optionalKey(Duration),
  goal: Goal,
  gates: Schema.optionalKey(
    Gates.pipe(
      Schema.refine((gates): gates is typeof gates => withoutFeedback(gates), {
        message: 'feedback-gate-needs-step',
      }),
    ),
  ),
  constraints: Schema.optionalKey(Schema.Array(Text)),
  steps: Schema.Array(Schema.Union([StepSchema, LoopSchema])),
  completion: Schema.optionalKey(CompletionSchema),
  finally: Schema.optionalKey(Schema.NonEmptyArray(StepSchema)),
  schedule: Schema.optionalKey(ScheduleSchema),
}).pipe(
  Schema.refine((m): m is typeof m => validGraph(m), {
    message:
      'mission needs unique graph nodes, existing dependencies and a normal completion frontier',
  }),
  Schema.annotate({ identifier: 'St.Mission' }),
)

const decode = <S extends Schema.ConstraintDecoder<unknown>>({
  schema,
  input,
}: {
  readonly schema: S
  readonly input: unknown
}): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)

/** Decodes an OMP harness selection, including optional conversation recovery. */
export const omp = ({
  model,
  effort,
  resume,
}: {
  readonly model: string
  readonly effort: 'low' | 'medium' | 'high'
  readonly resume?: typeof OmpResumeSchema.Encoded
}): typeof OmpSchema.Type =>
  decode({
    schema: OmpSchema,
    input: { kind: 'omp', model, effort, ...(resume === undefined ? {} : { resume }) },
  })

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
export const document = (input: typeof DocSchema.Encoded): Node => {
  const d = decode({ schema: DocSchema, input })
  return node({
    name: 'doc',
    args: [d.id],
    children: [child({ name: 'hash', value: d.hash.toLowerCase() })],
  })
}

/** Decodes and renders a ref observer, including repeated selected fields. */
export const observer = (input: typeof ObserverSchema.Encoded): Node => {
  const o = decode({ schema: ObserverSchema, input })
  return node({
    name: 'observer',
    args: [o.id],
    children: [
      child({ name: 'resource', value: o.resource }),
      child({ name: 'provider', value: o.provider }),
      child({ name: 'locator', value: o.locator }),
      ...o.fields.map((field) => child({ name: 'field', value: field })),
      ...optionalChild({ name: 'every', value: o.every }),
    ],
  })
}

/** Decodes and renders a message subscription to ref observations. */
export const subscription = (input: typeof SubscriptionSchema.Encoded): Node => {
  const s = decode({ schema: SubscriptionSchema, input })
  return node({
    name: 'subscription',
    args: [s.id],
    children: [
      child({ name: 'observer', value: s.observer }),
      child({ name: 'to', value: s.to }),
      ...s.on.map((field) => child({ name: 'on', value: field })),
      ...(s.when === undefined
        ? []
        : [
            block({
              name: 'when',
              children: [
                node({ name: 'field', args: [s.when.path, s.when.operator, s.when.value] }),
              ],
            }),
          ]),
      child({ name: 'delivery', value: s.delivery }),
    ],
  })
}

const ownedDeclarationNodes = (input: {
  readonly resources?: readonly (typeof ResourceSchema.Encoded)[]
  readonly docs?: readonly (typeof DocSchema.Encoded)[]
  readonly observers?: readonly (typeof ObserverSchema.Encoded)[]
  readonly subscriptions?: readonly (typeof SubscriptionSchema.Encoded)[]
}): Node[] => [
  ...(input.resources ?? []).map(resource),
  ...(input.docs ?? []).map(document),
  ...(input.observers ?? []).map(observer),
  ...(input.subscriptions ?? []).map(subscription),
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
const lowerGate = (input: typeof GateSchema.Encoded): Node => {
  const g = decode({ schema: GateSchema, input })
  if (g.kind === 'human') {
    return node({
      name: 'gate',
      args: [g.name],
      props: {
        type: 'human',
        mode: g.mode ?? 'approve',
      },
      children: [
        child({ name: 'reviewer', value: g.reviewer.subject }),
        ...optionalChild({ name: 'question', value: g.question }),
        ...(g.review ?? []).map((target) => child({ name: 'review', value: target })),
      ],
    })
  }
  let predicate: Node
  switch (g.kind) {
    case 'exists':
    case 'empty':
    case 'document':
      predicate = child({ name: g.kind, value: g.subject })
      break
    case 'has':
    case 'lacks':
      predicate = node({ name: g.kind, args: [g.subject, g.text] })
      break
    case 'field':
      predicate = node({ name: 'field', args: [g.path, g.subject, g.operator, g.value] })
      break
    case 'merged':
      predicate = child({ name: 'merged', value: g.locator })
      break
    case 'ci-passed':
      predicate = node({ name: 'ci-passed', args: [g.check], props: { repo: g.repo, ...g.ref } })
      break
    case 'exec':
      predicate = child({ name: 'exec', value: g.command })
      break
  }
  return node({
    name: 'gate',
    args: [g.name],
    children: [
      predicate,
      ...(g.kind === 'merged' || g.kind === 'ci-passed' || g.kind === 'exec'
        ? [
            ...optionalChild({ name: 'host', value: g.host }),
            ...optionalChild({ name: 'workspace', value: g.workspace }),
            ...optionalChild({ name: 'time-limit', value: g.timeLimit }),
            ...(g.kind === 'exec' && g.env !== undefined
              ? [
                  block({
                    name: 'env',
                    children: Object.entries(g.env)
                      .toSorted(([a], [b]) => a.localeCompare(b, 'en'))
                      .map(([name, value]) => child({ name, value })),
                  }),
                ]
              : []),
          ]
        : []),
    ],
  })
}

/** Native person review gate data. */
export type HumanGate = Extract<typeof GateSchema.Encoded, { readonly kind: 'human' }>
/** Native command gate data. */
export type ExecGate = Extract<typeof GateSchema.Encoded, { readonly kind: 'exec' }>
/** Native graph-field predicate data. */
export type FieldGate = Extract<typeof GateSchema.Encoded, { readonly kind: 'field' }>
/** Native merged pull-request gate data. */
export type MergedGate = Extract<typeof GateSchema.Encoded, { readonly kind: 'merged' }>
/** Native CI check gate data. */
export type CiPassedGate = Extract<typeof GateSchema.Encoded, { readonly kind: 'ci-passed' }>

const withReferences = <TGate extends object>({
  value,
  references,
}: {
  readonly value: TGate
  readonly references: readonly RunReference[]
}): TGate => {
  gateReferences.set(value, references)
  return value
}
type ReviewTarget = string | ResourceInput | ProductHandle
/** A graph-field gate retaining the known field names of typed products. */
export type FieldIsInput<TFields extends ProductFields = ProductFields> = Omit<
  FieldGate,
  'kind' | 'operator' | 'subject' | 'path' | 'name'
> & { readonly name?: string } & (
    | { readonly subject: string | ResourceInput; readonly path: string }
    | {
        readonly subject: ProductHandle<TFields>
        readonly path: Extract<keyof NoInfer<TFields>, string>
      }
  )

type Named<TGate extends { readonly name: string }> = Omit<TGate, 'name'> & {
  readonly name?: string
}

const derivedGateName = (kind: string, identity: string): string => {
  const name = `${kind}:${identity}`
  return Buffer.byteLength(name, 'utf8') <= 160
    ? name
    : `${kind}:${createHash('sha256').update(identity).digest('hex')}`
}

type AuthoredText = string | TextTemplate
type AuthoredGoal = AuthoredText | readonly [AuthoredText, ...AuthoredText[]]
const referencesInText = (value: AuthoredText): readonly RunReference[] =>
  typeof value === 'string' ? [] : templateReferences(value)

const human = (
  input: Named<Omit<HumanGate, 'kind' | 'review' | 'question'>> & {
    readonly question?: AuthoredText
    readonly review?: readonly ReviewTarget[]
  },
): HumanGate => {
  const { review, question, ...rest } = input
  const questionText = question === undefined ? undefined : templateText(question)
  return withReferences<HumanGate>({
    value: {
      ...rest,
      name:
        input.name ?? derivedGateName('human', `${input.reviewer.subject}:${questionText ?? ''}`),
      kind: 'human',
      ...(questionText === undefined ? {} : { question: questionText }),
      ...(review === undefined
        ? {}
        : {
            review: review.map((value) =>
              typeof value === 'string' ? value : referenceText(value),
            ),
          }),
    },
    references: [
      ...(question === undefined ? [] : referencesInText(question)),
      ...(review ?? []).filter(
        (value): value is ResourceInput | ProductHandle => typeof value !== 'string',
      ),
    ],
  })
}

const exec = (
  input: Named<Omit<ExecGate, 'kind' | 'env' | 'command'>> & {
    readonly command: AuthoredText
    readonly env?: Readonly<Record<string, string | RunReference | TextTemplate>>
  },
): ExecGate => {
  const { env, command, ...rest } = input
  const commandText = templateText(command)
  return withReferences<ExecGate>({
    value: {
      ...rest,
      name:
        input.name ?? derivedGateName('exec', `${input.host}:${input.workspace}:${commandText}`),
      kind: 'exec',
      command: commandText,
      ...(env === undefined
        ? {}
        : {
            env: Object.fromEntries(
              Object.entries(env).map(([name, value]) => [
                name,
                typeof value === 'string'
                  ? value
                  : 'kind' in value && value.kind === 'template'
                    ? templateText(value)
                    : referenceText(value),
              ]),
            ),
          }),
    },
    references: [
      ...referencesInText(command),
      ...Object.values(env ?? {}).flatMap((value) =>
        typeof value === 'string'
          ? []
          : 'kind' in value && value.kind === 'template'
            ? templateReferences(value)
            : [value],
      ),
    ],
  })
}

const fieldIs = <const TFields extends ProductFields>(input: FieldIsInput<TFields>): FieldGate => {
  const subject = typeof input.subject === 'string' ? input.subject : referenceText(input.subject)
  return withReferences<FieldGate>({
    value: {
      ...input,
      name: input.name ?? derivedGateName('field', `${subject}:${input.path}:${input.value}`),
      kind: 'field',
      operator: 'is',
      subject,
    },
    references: typeof input.subject === 'string' ? [] : [input.subject],
  })
}

const merged = (
  target: PullRequestReference | TextTemplate,
  options: Named<Omit<MergedGate, 'kind' | 'locator'>> = {},
): MergedGate => {
  const locator =
    target.kind === 'pull-request' ? `${target.repo}#${target.number}` : templateText(target)
  return withReferences<MergedGate>({
    value: {
      ...options,
      name: options.name ?? derivedGateName('merged', locator),
      kind: 'merged',
      locator,
    },
    references: target.kind === 'pull-request' ? [] : templateReferences(target),
  })
}

type CiPassedOptions = Named<Omit<CiPassedGate, 'kind' | 'check' | 'ref'>> &
  (
    | { readonly commit: string | TextInput | TextTemplate; readonly branch?: never }
    | { readonly branch: string | TextInput | TextTemplate; readonly commit?: never }
  )
const ciPassed = (check: string, options: CiPassedOptions): CiPassedGate => {
  const { commit, branch, ...rest } = options
  const value = commit ?? branch
  if (value === undefined || (commit !== undefined && branch !== undefined))
    throw new TypeError('ciPassed requires exactly one commit or branch')
  const text =
    typeof value === 'string'
      ? value
      : isInputHandle(value)
        ? referenceText(value)
        : templateText(value)
  return withReferences<CiPassedGate>({
    value: {
      ...rest,
      name: options.name ?? derivedGateName('ci-passed', `${options.repo}:${check}:${text}`),
      kind: 'ci-passed',
      check,
      ref: commit === undefined ? { branch: text } : { commit: text },
    },
    references:
      typeof value === 'string' ? [] : isInputHandle(value) ? [value] : templateReferences(value),
  })
}

/** Native gate constructors. Explicit names retain an existing gate's identity. */
export const gate = {
  human,
  exec,
  fieldIs,
  merged,
  ciPassed,
  document: (
    target: DocumentReference,
    options: { readonly name?: string } = {},
  ): Extract<typeof GateSchema.Encoded, { readonly kind: 'document' }> =>
    withReferences<Extract<typeof GateSchema.Encoded, { readonly kind: 'document' }>>({
      value: {
        kind: 'document',
        name: options.name ?? derivedGateName('document', target.subject),
        subject: target.subject,
      },
      references: templateReferences(target),
    }),
  exists: (
    subject: string,
    options: { readonly name?: string } = {},
  ): Extract<typeof GateSchema.Encoded, { readonly kind: 'exists' }> => ({
    kind: 'exists',
    name: options.name ?? derivedGateName('exists', subject),
    subject,
  }),
  empty: (
    subject: string,
    options: { readonly name?: string } = {},
  ): Extract<typeof GateSchema.Encoded, { readonly kind: 'empty' }> => ({
    kind: 'empty',
    name: options.name ?? derivedGateName('empty', subject),
    subject,
  }),
  has: (
    subject: string,
    text: string,
    options: { readonly name?: string } = {},
  ): Extract<typeof GateSchema.Encoded, { readonly kind: 'has' | 'lacks' }> => ({
    kind: 'has',
    name: options.name ?? derivedGateName('has', `${subject}:${text}`),
    subject,
    text,
  }),
  lacks: (
    subject: string,
    text: string,
    options: { readonly name?: string } = {},
  ): Extract<typeof GateSchema.Encoded, { readonly kind: 'has' | 'lacks' }> => ({
    kind: 'lacks',
    name: options.name ?? derivedGateName('lacks', `${subject}:${text}`),
    subject,
    text,
  }),
  render: lowerGate,
}

const productsNode = (products: readonly (typeof ProductSchema.Encoded)[]): Node =>
  block({
    name: 'produces',
    children: products.map((value) => {
      const separator = value.subject.indexOf('/')
      return node({
        name: value.subject.slice(0, separator),
        args: [value.subject.slice(separator + 1)],
        children: Object.entries(value.fields).map(([name, field]) =>
          child({ name, value: field }),
        ),
      })
    }),
  })

/** Decodes and renders a step node. */
const lowerStep = (input: typeof StepSchema.Encoded): Node => {
  const s = decode({ schema: StepSchema, input })
  const children: Node[] = []
  if (s.agentless === true) children.push(node({ name: 'agentless' }))
  if (s.assignedTo !== undefined) {
    children.push(
      child({
        name: 'assigned-to',
        value: 'id' in s.assignedTo ? `agent/${s.assignedTo.id}` : s.assignedTo.subject,
      }),
    )
  }
  if (s.dependsOn !== undefined) {
    children.push(
      block({
        name: 'depends-on',
        children: s.dependsOn.map((d) => node({ name: 'step', args: [d.step, d.state] })),
      }),
    )
  }
  for (const goal of s.goal ?? []) children.push(child({ name: 'goal', value: goal }))
  for (const document of s.documents ?? [])
    children.push(child({ name: 'document', value: document }))
  children.push(...ownedDeclarationNodes(s))
  if (s.produces !== undefined) children.push(productsNode(s.produces))
  if (s.producesMission !== undefined)
    children.push(child({ name: 'produces-mission', value: s.producesMission }))
  if (s.usesMission !== undefined)
    children.push(
      s.usesMission.kind === 'revision'
        ? child({ name: 'uses-mission', value: s.usesMission.revision })
        : node({ name: 'uses-mission', props: { 'output-of': s.usesMission.outputOf } }),
    )
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
  children.push(...(s.gates ?? []).map(lowerGate))
  if (s.retry !== undefined)
    children.push(
      block({
        name: 'retry',
        children: [
          child({ name: 'attempts', value: s.retry.attempts }),
          ...optionalChild({ name: 'backoff', value: s.retry.backoff }),
        ],
      }),
    )
  return node({
    name: 'step',
    args: [s.id],
    props: s.timeout === undefined ? {} : { timeout: s.timeout },
    children,
  })
}

const stepBrand = Symbol('StepHandle')
const dependencyBrand = Symbol('StepDependency')

/** A renderable step with explicit identity and, optionally, a literal mission scope. */
export interface StepHandle<
  TMission extends string = string,
  TProducts extends Products = Products,
> extends Node {
  readonly [stepBrand]: true
  readonly missionId?: TMission
  readonly id: string
  readonly products: TProducts
}

/** A step whose attempt-bound output is a complete ready child mission. */
export interface MissionProducer<TMission extends string = string> extends StepHandle<TMission> {
  readonly childMission: ChildMission
}

/** A handle dependency on a native step terminal state. */
export interface StepDependency<TMission extends string = string> {
  readonly [dependencyBrand]: true
  readonly handle: StepHandle<TMission>
  readonly state: typeof DependsOnSchema.Encoded.state
}

type StepDependencyInput<TMission extends string> =
  | typeof DependencyItem.Encoded
  | StepDependency<NoInfer<TMission>>
  | StepHandle<NoInfer<TMission>>
/** Step authoring data with scoped dependencies, resolved workers and named products. */
export type StepInput<TMission extends string, TProducts extends Products = Products> = Omit<
  typeof StepSchema.Encoded,
  'goal' | 'dependsOn' | 'produces' | 'producesMission' | 'usesMission'
> & {
  readonly missionId?: TMission
  readonly goal?: AuthoredGoal
  readonly dependsOn?:
    | StepDependencyInput<TMission>
    | readonly [StepDependencyInput<TMission>, ...StepDependencyInput<TMission>[]]
  readonly produces?: TProducts | ChildMission
  readonly waitFor?:
    | MissionProducer<NoInfer<TMission>>
    | Extract<typeof UsedMissionSchema.Encoded, { readonly kind: 'revision' }>
}
/** Mission authoring data retaining typed input and step identities until assembly. */
export type MissionInput<TMission extends string> = Omit<
  typeof MissionSchema.Encoded,
  'id' | 'goal' | 'steps' | 'finally' | 'inputs'
> & {
  readonly id: TMission
  readonly goal: AuthoredGoal
  readonly inputs?: readonly (InputHandle | typeof MissionInputSchema.Encoded)[]
  readonly steps: readonly (
    | ((typeof StepSchema.Encoded | typeof LoopSchema.Encoded) & { readonly [stepBrand]?: never })
    | StepHandle<NoInfer<TMission>>
  )[]
  readonly finally?: readonly (
    | (typeof StepSchema.Encoded & { readonly [stepBrand]?: never })
    | StepHandle<NoInfer<TMission>>
  )[]
}

const stepData = new WeakMap<
  object,
  {
    readonly missionId?: string
    readonly wire: typeof StepSchema.Encoded
    readonly dependencies: readonly StepDependency[]
    readonly references: readonly RunReference[]
    readonly missionOutput?: StepHandle
  }
>()
const stepOwners = new WeakMap<object, string>()
const productOwners = new WeakMap<ProductHandle, Node>()
const gateReferences = new WeakMap<object, readonly RunReference[]>()
const isStepHandle = (value: object): value is StepHandle => stepData.has(value)

const stepDependency = <TMission extends string>({
  handle,
  state,
}: {
  readonly handle: StepHandle<TMission>
  readonly state: StepDependency['state']
}): StepDependency<TMission> => ({ [dependencyBrand]: true, handle, state })
/** Wait for a step to complete successfully. */
export const completed = <TMission extends string>(
  handle: StepHandle<TMission>,
): StepDependency<TMission> => stepDependency({ handle, state: 'completed' })
/** Wait for a step to fail. */
export const failed = <TMission extends string>(
  handle: StepHandle<TMission>,
): StepDependency<TMission> => stepDependency({ handle, state: 'failed' })
/** Wait for either terminal step state. */
export const terminal = <TMission extends string>(
  handle: StepHandle<TMission>,
): StepDependency<TMission> => stepDependency({ handle, state: 'terminal' })

/** `missionId` gives static scope checking; unscoped/plain-data steps are checked when assembled. */
export function step<const TMission extends string = never>(
  input: StepInput<TMission> & { readonly produces: ChildMission },
): MissionProducer<TMission>
export function step<const TMission extends string = never, const TProducts extends Products = {}>(
  input: StepInput<TMission, TProducts>,
): StepHandle<TMission, TProducts>
export function step(input: StepInput<string>): StepHandle {
  const { missionId, assignedTo, dependsOn, produces, waitFor, goal, ...rest } = input
  const goalValues: readonly AuthoredText[] =
    goal === undefined ? [] : typeof goal === 'string' || 'kind' in goal ? [goal] : goal
  const childOutput = produces !== undefined && isChildMission(produces) ? produces : undefined
  const missionOutput = waitFor !== undefined && isStepHandle(waitFor) ? waitFor : undefined
  if (waitFor !== undefined && isStepHandle(waitFor) === false && waitFor.kind !== 'revision')
    throw new TypeError('waitFor must reference a producing step or an exact mission revision')
  if (waitFor !== undefined && input.agentless !== true)
    throw new TypeError('A child-mission waitFor step must be agentless')
  if (missionOutput !== undefined) {
    const producer = stepData.get(missionOutput)!
    if (producer.wire.producesMission === undefined)
      throw new TypeError('waitFor target does not produce a child mission')
  }
  const dependencyInputs: readonly StepDependencyInput<string>[] =
    dependsOn === undefined
      ? []
      : typeof dependsOn === 'string' ||
          'step' in dependsOn ||
          dependencyBrand in dependsOn ||
          isStepHandle(dependsOn)
        ? [dependsOn]
        : dependsOn
  const dependencies: readonly StepDependency[] = dependencyInputs.flatMap((dependency) =>
    typeof dependency === 'string'
      ? []
      : dependencyBrand in dependency
        ? [dependency]
        : isStepHandle(dependency)
          ? [completed(dependency)]
          : [],
  )
  const seenProducts = new Set<ProductHandle>()
  const products = produces === undefined || isChildMission(produces) ? {} : produces
  const materializedProducts = Object.entries(products).map(([name, value]) => {
    Schema.decodeSync(LocalId)(name)
    if (productOwners.has(value) === true)
      throw new TypeError('Product handle already belongs to a step')
    if (seenProducts.has(value) === true)
      throw new TypeError('Product handle occurs under multiple produces keys')
    seenProducts.add(value)
    return {
      value,
      subject: value.subject ?? `resource/mission-run/\${ST_MISSION_RUN}/${input.id}/${name}`,
    }
  })
  const wire = decode({
    schema: StepSchema,
    input: {
      ...rest,
      ...(produces === undefined || childOutput !== undefined
        ? {}
        : {
            produces: materializedProducts.map(({ subject, value }) => ({
              subject,
              fields: value.fields,
            })),
          }),
      ...(childOutput === undefined ? {} : { producesMission: childOutput.id }),
      ...(assignedTo === undefined ? {} : { assignedTo }),
      ...(goal === undefined ? {} : { goal: goalValues.map(templateText) }),
      ...(waitFor === undefined
        ? {}
        : {
            usesMission:
              missionOutput !== undefined
                ? { kind: 'output', outputOf: missionOutput.id }
                : waitFor,
          }),
      ...(dependsOn === undefined
        ? {}
        : {
            dependsOn: dependencyInputs.map((dependency) =>
              typeof dependency === 'string'
                ? dependency
                : dependencyBrand in dependency
                  ? { step: dependency.handle.id, state: dependency.state }
                  : isStepHandle(dependency)
                    ? { step: dependency.id, state: 'completed' }
                    : dependency,
            ),
          }),
    },
  })
  const rendered = lowerStep(wire)
  const handle = {
    ...rendered,
    [stepBrand]: true as const,
    ...(missionId === undefined ? {} : { missionId }),
    id: input.id,
    products,
    ...(childOutput === undefined ? {} : { childMission: childOutput }),
  }
  for (const { value, subject } of materializedProducts) {
    productOwners.set(value, handle)
    productSubjects.set(value, subject)
  }
  stepData.set(handle, {
    ...(missionId === undefined ? {} : { missionId }),
    wire,
    dependencies,
    references: [
      ...(input.gates ?? []).flatMap((g) => gateReferences.get(g) ?? []),
      ...goalValues.flatMap(referencesInText),
      ...(childOutput === undefined ? [] : templateReferences(childOutput)),
    ],
    ...(missionOutput === undefined ? {} : { missionOutput }),
  })
  return handle
}

const dependenciesNode = (dependencies: readonly (typeof DependsOnSchema.Encoded)[]): Node =>
  block({
    name: 'depends-on',
    children: dependencies.map((d) => node({ name: 'step', args: [d.step, d.state] })),
  })

/** Lowers an explicit completion frontier. */
export const completion = (input: typeof CompletionSchema.Encoded): Node => {
  const c = decode({ schema: CompletionSchema, input })
  return block({
    name: 'completion',
    children:
      'when' in c ? [child({ name: 'when', value: c.when })] : [dependenciesNode(c.dependsOn)],
  })
}

/** Lowers a loop and its explicitly completed round mission. */
export const loop = (input: typeof LoopSchema.Encoded): Node => {
  if (loopReferences(input).length > 0)
    throw new TypeError('Typed references in loops require mission assembly')
  const l = decode({ schema: LoopSchema, input })
  return node({
    name: 'loop',
    args: [l.id],
    props: l.timeout === undefined ? {} : { timeout: l.timeout },
    children: [
      ...(l.dependsOn === undefined ? [] : [dependenciesNode(l.dependsOn)]),
      child({ name: 'max-rounds', value: l.maxRounds }),
      ...(l.until === undefined
        ? []
        : [block({ name: 'until', children: l.until.map(lowerGate) })]),
      block({
        name: 'round',
        children: [
          completion(l.round.completion),
          ...l.round.steps.map(lowerStep),
          ...ownedDeclarationNodes(l.round),
          ...(l.round.finally === undefined
            ? []
            : [block({ name: 'finally', children: l.round.finally.map(lowerStep) })]),
        ],
      }),
      ...(l.onExhausted === undefined
        ? []
        : [
            block({
              name: 'on-exhausted',
              children: [
                node({ name: l.onExhausted.outcome }),
                ...(l.onExhausted.outcome === 'fail' && l.onExhausted.attention !== undefined
                  ? [
                      node({
                        name: 'attention',
                        args: [l.onExhausted.attention.title],
                        children: [
                          child({
                            name: 'reviewer',
                            value: l.onExhausted.attention.reviewer.subject,
                          }),
                          child({ name: 'severity', value: l.onExhausted.attention.severity }),
                        ],
                      }),
                    ]
                  : []),
              ],
            }),
          ]),
    ],
  })
}

const referencesInGates = (
  gates: readonly (typeof GateSchema.Encoded)[] = [],
): readonly RunReference[] => gates.flatMap((value) => gateReferences.get(value) ?? [])
const loopReferences = (input: typeof LoopSchema.Encoded): readonly RunReference[] => [
  ...referencesInGates(input.until),
  ...input.round.steps.flatMap((value) => referencesInGates(value.gates)),
  ...(input.round.finally ?? []).flatMap((value) => referencesInGates(value.gates)),
]

const assembleMission = <const TMission extends string>(
  input: MissionInput<TMission>,
): typeof MissionSchema.Type => {
  const allHandles = [...input.steps, ...(input.finally ?? [])].filter(isStepHandle)
  const referenced = [
    ...referencesInGates(input.gates),
    ...(typeof input.goal === 'string' || 'kind' in input.goal ? [input.goal] : input.goal).flatMap(
      referencesInText,
    ),
    ...[...input.steps, ...(input.finally ?? [])].flatMap((value) =>
      isStepHandle(value) === true
        ? stepData.get(value)!.references
        : 'round' in value
          ? loopReferences(value)
          : referencesInGates(value.gates),
    ),
  ]
  for (const ref of referenced) {
    if (isInputHandle(ref) === true) {
      const declared: readonly object[] = input.inputs ?? []
      if (declared.includes(ref) === false)
        throw new TypeError(`Input ${ref.name} is not declared by this mission`)
    } else if (allHandles.some((handle) => handle === productOwners.get(ref)) === false) {
      throw new TypeError('Product reference belongs to a step outside this mission')
    }
  }
  for (const handle of allHandles) {
    const data = stepData.get(handle)!
    if (data.missionId !== undefined && data.missionId !== input.id) {
      throw new TypeError(
        `Step ${data.wire.id} belongs to mission ${data.missionId}, not ${input.id}`,
      )
    }
    const owner = stepOwners.get(handle)
    if (owner !== undefined && owner !== input.id) {
      throw new TypeError(`Step ${data.wire.id} already belongs to mission ${owner}`)
    }
    const normalPhase: readonly object[] = input.steps
    const phase: readonly object[] =
      normalPhase.includes(handle) === true ? input.steps : (input.finally ?? [])
    if (data.missionOutput !== undefined && phase.includes(data.missionOutput) === false)
      throw new TypeError('Mission output producer is not a handle in the same mission phase')
    for (const dependency of data.dependencies) {
      if (phase.includes(dependency.handle) === false) {
        throw new TypeError(
          `Dependency ${dependency.handle.id} is not a handle in the same mission phase`,
        )
      }
    }
  }
  const goalValues: readonly AuthoredText[] =
    typeof input.goal === 'string' || 'kind' in input.goal ? [input.goal] : input.goal
  const m = decode({
    schema: MissionSchema,
    input: {
      ...input,
      goal: goalValues.map(templateText),
      ...(input.inputs === undefined
        ? {}
        : {
            inputs: input.inputs.map((value) =>
              isInputHandle(value) === true ? { name: value.name, kind: value.kind } : value,
            ),
          }),
      steps: input.steps.map((s) => (isStepHandle(s) === true ? stepData.get(s)!.wire : s)),
      ...(input.finally === undefined
        ? {}
        : {
            finally: input.finally.map((s) =>
              isStepHandle(s) === true ? stepData.get(s)!.wire : s,
            ),
          }),
    },
  })
  const inputNames = new Set((m.inputs ?? []).map((value) => value.name))
  const validateInputText = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/(?<!\$)\$\{input\.([^}]+)\}/gu)) {
        if (inputNames.has(match[1]!) === false)
          throw new TypeError(`Input ${match[1]} is not declared by this mission`)
      }
    } else if (Array.isArray(value)) {
      for (const item of value) validateInputText(item)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key !== 'reportTo' && key !== 'assignedTo') validateInputText(item)
      }
    }
  }
  validateInputText(m)
  for (const handle of allHandles) stepOwners.set(handle, input.id)
  return m
}

const wireStep = (value: typeof StepSchema.Type): typeof StepSchema.Type =>
  value.assignedTo !== undefined && 'id' in value.assignedTo
    ? { ...value, assignedTo: { id: value.assignedTo.id } }
    : value

const wireFinalSteps = (
  values: readonly [typeof StepSchema.Type, ...(typeof StepSchema.Type)[]],
): readonly [typeof StepSchema.Type, ...(typeof StepSchema.Type)[]] => {
  const result: [typeof StepSchema.Type, ...(typeof StepSchema.Type)[]] = [wireStep(values[0])]
  for (let index = 1; index < values.length; index++) result.push(wireStep(values[index]!))
  return result
}

/** Validates authoring references and materializes plain wire data before serialization. */
export const missionWire = <const TMission extends string>(
  input: MissionInput<TMission>,
): typeof MissionSchema.Encoded => {
  const m = assembleMission(input)
  return {
    ...m,
    reportTo: { id: m.reportTo.id },
    ...(m.assignedTo !== undefined && 'id' in m.assignedTo
      ? { assignedTo: { id: m.assignedTo.id } }
      : {}),
    steps: m.steps.map((value) =>
      'maxRounds' in value
        ? {
            ...value,
            round: {
              ...value.round,
              steps: value.round.steps.map(wireStep),
              ...(value.round.finally === undefined
                ? {}
                : { finally: wireFinalSteps(value.round.finally) }),
            },
          }
        : wireStep(value),
    ),
    ...(m.finally === undefined ? {} : { finally: wireFinalSteps(m.finally) }),
  }
}

/** Decodes and renders a mission, including its validated steps and native gates. */
export const mission = <const TMission extends string>(input: MissionInput<TMission>): Node => {
  const m = assembleMission(input)
  return node({
    name: 'mission',
    args: [m.id],
    props: {
      state: m.state,
      'report-to': `agent/${m.reportTo.id}`,
      ...(m.timeout === undefined ? {} : { timeout: m.timeout }),
    },
    children: [
      ...(m.inputs ?? []).map((value) =>
        node({ name: 'input', args: [value.name], props: { kind: value.kind } }),
      ),
      ...(m.assignedTo === undefined
        ? []
        : [
            child({
              name: 'assigned-to',
              value: 'id' in m.assignedTo ? `agent/${m.assignedTo.id}` : m.assignedTo.subject,
            }),
          ]),
      ...m.goal.map((goal) => child({ name: 'goal', value: goal })),
      ...(m.gates ?? []).map(lowerGate),
      ...(m.constraints ?? []).map((constraint) =>
        child({ name: 'constraint', value: constraint }),
      ),
      ...ownedDeclarationNodes(m),
      ...(m.schedule === undefined ? [] : [schedule(m.schedule)]),
      ...(m.completion === undefined ? [] : [completion(m.completion)]),
      ...m.steps.map((s) => ('maxRounds' in s ? loop(s) : lowerStep(s))),
      ...(m.finally === undefined
        ? []
        : [block({ name: 'finally', children: m.finally.map(lowerStep) })]),
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
        args: [`agent/${under.target.id}`],
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
  const env = { ...a.env }
  if (a.harness?.kind === 'codex' && a.harness.resume !== undefined) {
    env.ST3_NATIVE_RESUME_SESSION = a.harness.resume.session
  }
  if (a.env !== undefined || Object.keys(env).length > 0) {
    const entries = Object.entries(env).toSorted(([x], [y]) => x.localeCompare(y, 'en'))
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
          ...(a.harness.kind === 'codex' && a.harness.args !== undefined
            ? [node({ name: 'args', args: a.harness.args })]
            : []),
          ...(a.harness.kind !== 'omp' || a.harness.resume === undefined
            ? []
            : [
                node({
                  name: 'args',
                  args:
                    a.harness.resume === 'latest'
                      ? ['--continue']
                      : ['--resume', a.harness.resume.transcript],
                }),
              ]),
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
