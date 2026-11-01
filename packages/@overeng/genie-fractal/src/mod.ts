import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
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
  utf8ByteLength,
} from './run-values.ts'
import {
  LaunchSchema,
  TimingSchema,
  ReviewSchema,
  DurationSchema as Duration,
  NonNegativeDurationSchema as NonNegativeDuration,
  launchReferences,
  lowerDuration,
  lowerInstant,
  lowerReview,
  reviewReferences,
  PinnedDocumentReferenceSchema,
  DocumentReferenceSchema,
  FullSubject,
  type Launch,
  type Review,
} from './values.ts'
export {
  Launch,
  Timing,
  Review,
  LaunchSchema,
  TimingSchema,
  ReviewSchema,
  DurationSchema,
  NonNegativeDurationSchema,
  InstantSchema,
  normalizeDuration,
  normalizeInstant,
  lowerDuration,
  lowerInstant,
  lowerLaunch,
  lowerTiming,
  lowerReview,
} from './values.ts'
export type {
  LaunchInput,
  LaunchOptions,
  TimingInput,
  CalendarInput,
  ReviewSubjectInput,
  DurationInput,
  InstantInput,
} from './values.ts'
export {
  CalendarTimeSchema,
  IanaTimezoneSchema,
  CalendarDaysSchema,
  DocumentReferenceSchema,
  PinnedDocumentReferenceSchema,
} from './values.ts'
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

const immutableNodes = new WeakSet<Node>()

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
}): Node => {
  const value = Object.freeze({
    name,
    args: Object.freeze([...args]),
    props: Object.freeze({ ...props }),
    ...(children === undefined
      ? {}
      : {
          children: Object.freeze(
            children.map((child) => (immutableNodes.has(child) === true ? child : node(child))),
          ),
        }),
  })
  immutableNodes.add(value)
  return value
}

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

/** An st subject ID, e.g. a seat or mission path; seats are addressed as `agent/<id>`. */
export const SubjectId = Schema.String.pipe(
  Schema.refine(
    (s): s is string =>
      s.length <= 512 &&
      /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(s) === true &&
      s.endsWith('/') === false &&
      s.split('/').some((part) => part === '..') === false,
    { message: 'invalid st subject ID' },
  ),
  Schema.brand('SubjectId'),
  Schema.annotate({ identifier: 'Fractal.SubjectId' }),
)

/** A validated st subject ID. */
export type SubjectId = typeof SubjectId.Type

const LocalId = Schema.String.pipe(
  Schema.refine(
    (s): s is string => s.length > 0 && utf8ByteLength(s) <= 160 && /[\s/]/u.test(s) === false,
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
      utf8ByteLength(s) <= 160 &&
      s.startsWith('/') === false &&
      s.endsWith('/') === false &&
      s.includes('//') === false &&
      /\s/u.test(s) === false,
    { message: 'invalid mission ID' },
  ),
  Schema.brand('MissionId'),
)

const Revision = Schema.String.pipe(
  Schema.refine(
    (s): s is string => {
      const at = s.lastIndexOf('@')
      const id = s.slice(0, at).replace(/^mission\//u, '')
      return (
        at > 0 &&
        Schema.is(MissionId)(id) === true &&
        /^[a-fA-F0-9]{64}$/u.test(s.slice(at + 1)) === true
      )
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
  launch: LaunchSchema,
})

const AgentTask = Schema.declare<typeof AgentTaskFields.Encoded>(
  (input): input is typeof AgentTaskFields.Encoded =>
    Schema.is(AgentTaskFields)(input) === true &&
    Reflect.ownKeys(input).every((key) => Object.hasOwn(AgentTaskFields.fields, key)) === true,
).annotate({ identifier: 'Fractal.AgentTask' })

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
]).annotate({ identifier: 'Fractal.OmpResume' })

/** OMP harness selection for a seat. */
export const OmpSchema = Schema.Struct({
  kind: Schema.Literal('omp'),
  model: Text,
  effort: Schema.optionalKey(Schema.Literals(['low', 'medium', 'high', 'xhigh'])),
  resume: Schema.optionalKey(OmpResumeSchema),
}).annotate({ identifier: 'Fractal.Omp' })

/** Codex harness selection with explicit model and effort routing. */
export const CodexSchema = Schema.Struct({
  kind: Schema.Literal('codex'),
  model: Text,
  effort: Text,
  args: Schema.optionalKey(Schema.Array(Text)),
  resume: Schema.optionalKey(Schema.Struct({ session: Text })),
}).annotate({ identifier: 'Fractal.Codex' })

/**
 * The ID view of an imported agent declaration. Validation still checks the full
 * AgentSchema; this structural view keeps under references from recursively
 * expanding AgentSchema's inferred type and retains the original object.
 */
export interface AgentReference {
  readonly id: string
}

const isAgentReference = (input: unknown): input is AgentReference =>
  isAgentDeclaration(input) === true && input.id.includes('//') === false

/** An imported agent object, validated lazily without copying launch or kit metadata. */
export const AgentReferenceSchema = Schema.declare<AgentReference>(isAgentReference).annotate({
  identifier: 'Fractal.AgentReference',
})

/** A person subject, distinct from the ID view of an imported agent declaration. */
export const PersonReferenceSchema = Schema.Struct({
  kind: Schema.Literal('person'),
  subject: Schema.String.pipe(
    Schema.refine(
      (subject): subject is `person/${string}` =>
        subject.startsWith('person/') === true &&
        subject.length > 'person/'.length &&
        subject.includes('//') === false &&
        Schema.is(SubjectId)(subject) === true,
      { message: 'invalid person subject' },
    ),
  ),
}).annotate({ identifier: 'Fractal.PersonReference' })

export type PersonReference = typeof PersonReferenceSchema.Type

/** References a named person; it is attribution, not a person credential. */
export const person = (subject: `person/${string}`): PersonReference =>
  Object.freeze(decode({ schema: PersonReferenceSchema, input: { kind: 'person', subject } }))

const AgentSchemaFields = Schema.Struct({
  id: SubjectId,
  identity: Schema.optionalKey(Text),
  name: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  principal: Schema.optionalKey(PersonReferenceSchema),
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
  launch: Schema.optionalKey(
    LaunchSchema.pipe(
      Schema.refine(
        (launch): launch is typeof launch => launch.cwd === undefined && launch.unset === undefined,
        { message: 'root agent launches do not support cwd or unset; use child tasks instead' },
      ),
    ),
  ),
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
  Number(a.launch !== undefined) + Number(a.harness !== undefined) <= 1 &&
  (a.launch === undefined || a.env === undefined) &&
  (a.env === undefined ||
    Object.keys(a.env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) === true) === true) &&
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
  Schema.annotate({ identifier: 'Fractal.Agent' }),
)

const isAgentShape = Schema.is(AgentSchema)
const isAgentDeclaration = (input: unknown): input is typeof AgentSchema.Type => {
  if (isAgentShape(input) === false) return false
  if ('kind' in input === false) return true
  return input.kind !== 'agent' && input.kind !== 'mission'
}

const GateName = Text.pipe(Schema.refine((s): s is string => utf8ByteLength(s) <= 160))
const validSubject = Schema.is(FullSubject)
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
      Schema.refine(
        (n): n is number => Number.isInteger(n) === false || Number.isSafeInteger(n) === true,
      ),
    ),
    Schema.Boolean,
  ]),
}).annotate({ identifier: 'Fractal.FieldGate' })

/**
 * A current-episode attributed review. Critical is the default: silence never passes.
 * TODO: authenticated-person-only decisions: https://github.com/compoundingtech/fractal/issues/2184
 */
export const HumanGateSchema = Schema.Struct({
  kind: Schema.Literal('human'),
  name: Text,
  reviewer: PersonReferenceSchema,
  mode: Schema.optionalKey(Schema.Literals(['approve', 'feedback'])),
  question: Schema.optionalKey(Text),
  review: Schema.optionalKey(
    Schema.Array(ReviewSchema).pipe(
      Schema.refine(
        (targets): targets is typeof targets =>
          new Set(targets.map(lowerReview)).size === targets.length,
        {
          message: 'human gate review targets must be unique',
        },
      ),
    ),
  ),
}).annotate({ identifier: 'Fractal.HumanGate' })

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
        (s): s is string =>
          s.includes('${') === true || /^[^/#]+\/[^/#]+#[1-9][0-9]*$/u.test(s) === true,
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
            (key) =>
              /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) === true && reservedGateEnvNames[key] !== true,
          ),
        ),
      ),
    ),
    timeLimit: Schema.optionalKey(Duration),
  }),
  HumanGateSchema,
]).annotate({ identifier: 'Fractal.Gate' })

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
}).annotate({ identifier: 'Fractal.Retry' })

/** An agentless command a step runs. */
export const ExecSchema = Schema.Struct({
  id: LocalId,
  host: Text,
  workspace: Text,
  launch: LaunchSchema,
  restart: Restart,
}).annotate({ identifier: 'Fractal.Exec' })

/** A dependency on another step reaching a state. */
export const DependsOnSchema = Schema.Struct({
  step: LocalId,
  state: Schema.Literals(['completed', 'failed', 'terminal']),
}).annotate({
  identifier: 'Fractal.DependsOn',
})
const DependencyItem = Schema.Union([LocalId, DependsOnSchema])
const DependencyInput = Schema.Union([DependencyItem, Schema.NonEmptyArray(DependencyItem)])
const normalizeDependency = (
  dependency: typeof DependencyItem.Type,
): typeof DependsOnSchema.Type =>
  typeof dependency === 'string' ? { step: dependency, state: 'completed' } : dependency
const Dependencies = DependencyInput.pipe(
  Schema.decodeTo(Schema.NonEmptyArray(Schema.toType(DependsOnSchema)), {
    decode: SchemaGetter.transform((value) => {
      const values: readonly [typeof DependencyItem.Type, ...(typeof DependencyItem.Type)[]] =
        typeof value === 'string' || 'step' in value ? [value] : value
      const [first, ...rest] = values
      return [normalizeDependency(first), ...rest.map(normalizeDependency)] as const
    }),
    encode: SchemaGetter.transform((value): typeof DependencyInput.Type => value),
  }),
)

/** A typed st resource. */
export const ResourceSchema = Schema.Struct({
  id: SubjectId,
  kind: Schema.Literals(['vcs.repository', 'filesystem.file', 'vcs.pull-request', 'vcs.ref']),
}).annotate({ identifier: 'Fractal.Resource' })

/** A named binding to a previously stored immutable document. */
export const DocSchema = Schema.Struct({
  id: SubjectId,
  hash: DocumentHash,
}).annotate({ identifier: 'Fractal.Doc' })

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
        slash > 0 &&
        slash < repository.length - 1 &&
        repository.slice(slash + 1).includes('/') === false
      )
    }),
  ),
  fields: Schema.NonEmptyArray(Schema.Literals(['head', 'ancestors'])).pipe(
    Schema.refine((fields): fields is typeof fields => new Set(fields).size === fields.length),
  ),
  every: Schema.optionalKey(Duration),
}).annotate({ identifier: 'Fractal.Observer' })

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
          Schema.refine(
            (n): n is number => Number.isInteger(n) === false || Number.isSafeInteger(n) === true,
          ),
        ),
        Schema.Boolean,
      ]),
    }),
  ),
}).annotate({ identifier: 'Fractal.Subscription' })

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
]).annotate({ identifier: 'Fractal.UsedMission' })

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
          values.every((value) => validSubject(value.subject)) === true &&
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
  Schema.refine(
    (s): s is typeof s => s.agentless !== true || withoutFeedback(s.gates ?? []) === true,
    {
      message: 'feedback human gates require a worker step',
    },
  ),
  Schema.annotate({ identifier: 'Fractal.Step' }),
)
/** All exhausted work, or an explicit completion frontier of normal steps. */
export const CompletionSchema = Schema.Union([
  Schema.Struct({ when: Schema.Literal('all-steps-exhausted') }),
  Schema.Struct({ dependsOn: Dependencies }),
]).annotate({ identifier: 'Fractal.Completion' })

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
          (s.dependsOn ?? []).every((d) => phase.some((target) => target.id === d.step)) === true &&
          (used?.kind !== 'output' ||
            (phase.some(
              (target) => target.id === used.outputOf && target.producesMission !== undefined,
            ) === true &&
              (s.dependsOn ?? []).some(
                (dependency) =>
                  dependency.step === used.outputOf && dependency.state === 'completed',
              ) === true))
        )
      }),
    ) === true &&
    (m.completion === undefined ||
      'when' in m.completion ||
      m.completion.dependsOn.every((d) => m.steps.some((s) => s.id === d.step)) === true)
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
  .annotate({ identifier: 'Fractal.Round' })

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
}).annotate({ identifier: 'Fractal.Loop' })

/**
 * Scheduled work names an exact `mission@revision`, or an unpinned mission ID whose ready
 * published head st resolves at each occurrence. st reads any `@` as a pinned reference.
 */
const ScheduledMission = Schema.Union([
  Revision,
  MissionId.pipe(
    Schema.refine((s): s is typeof s => s.includes('@') === false, {
      message: 'expected mission@64-hex revision or unpinned mission ID',
    }),
  ),
])

/** The mission, pinned or unpinned, and workspace a schedule starts. */
export const WorkSchema = Schema.Struct({ mission: ScheduledMission, workspace: Text }).annotate({
  identifier: 'Fractal.Work',
})

/** A native schedule with one normalized timing value. */
export const ScheduleSchema = Schema.Struct({
  id: LocalId,
  host: Schema.Literal('local'),
  work: WorkSchema,
  timing: TimingSchema,
}).annotate({ identifier: 'Fractal.Schedule' })

/**
 * Reference an imported agent declaration without copying its launch configuration.
 * Native st reports only to agents; people must be reached through their own agent.
 * Kit metadata on the declaration is not part of the reference.
 */
export const ReportToSchema = Schema.declare<typeof AgentSchema.Encoded>(isAgentDeclaration).pipe(
  Schema.refine((a): a is typeof a => a.id.includes('//') === false, {
    message: 'report-to agent ID must not contain empty path segments',
  }),
  Schema.annotate({ identifier: 'Fractal.ReportTo' }),
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
  stalledAfter: Schema.optionalKey(Duration),
  reportStalls: Schema.optionalKey(Schema.Boolean),
  reportCompleted: Schema.optionalKey(Schema.Boolean),
  goal: Goal,
  gates: Schema.optionalKey(
    Gates.pipe(
      Schema.refine((gates): gates is typeof gates => withoutFeedback(gates), {
        message: 'feedback-gate-needs-step',
      }),
    ),
  ),
  constraints: Schema.optionalKey(Schema.Array(Text)),
  lanes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: LocalId,
        entries: Schema.optionalKey(
          Schema.String.pipe(
            Schema.refine((value): value is string => value.endsWith('/'), {
              message: 'lane entries must end with /',
            }),
          ),
        ),
        approver: Schema.optionalKey(
          Schema.String.pipe(
            Schema.refine((value): value is string => value.startsWith('person/'), {
              message: 'lane approver must start with person/',
            }),
          ),
        ),
      }),
    ).pipe(
      Schema.refine(
        (lanes): lanes is typeof lanes =>
          new Set(lanes.map((lane) => lane.name)).size === lanes.length,
        { message: 'lane names must be unique within a mission' },
      ),
    ),
  ),
  steps: Schema.Array(Schema.Union([StepSchema, LoopSchema])),
  completion: Schema.optionalKey(CompletionSchema),
  finally: Schema.optionalKey(Schema.NonEmptyArray(StepSchema)),
  schedule: Schema.optionalKey(ScheduleSchema),
}).pipe(
  Schema.refine((m): m is typeof m => validGraph(m), {
    message:
      'mission needs unique graph nodes, existing dependencies and a normal completion frontier',
  }),
  Schema.annotate({ identifier: 'Fractal.Mission' }),
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
  readonly effort?: (typeof OmpSchema.Encoded)['effort']
  readonly resume?: typeof OmpResumeSchema.Encoded
}): typeof OmpSchema.Type =>
  snapshotComposition(
    decode({
      schema: OmpSchema,
      input: {
        kind: 'omp',
        model,
        ...(effort === undefined ? {} : { effort }),
        ...(resume === undefined ? {} : { resume }),
      },
    }),
  )

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
const renderDocument = (input: typeof DocSchema.Encoded): Node => {
  const d = decode({ schema: DocSchema, input })
  return node({
    name: 'doc',
    args: [d.id],
    children: [child({ name: 'hash', value: d.hash.toLowerCase() })],
  })
}
export { renderDocument as document }

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
      ...optionalChild({ name: 'every', value: nativeDuration(o.every) }),
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
  ...(input.docs ?? []).map(renderDocument),
  ...(input.observers ?? []).map(observer),
  ...(input.subscriptions ?? []).map(subscription),
]

const nativeDuration = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : lowerDuration(value)

const launchNodes = (launch: Launch): readonly Node[] => [
  launch._tag === 'Argv'
    ? node({ name: 'argv', args: launch.argv })
    : child({ name: 'command', value: launch.command }),
  ...optionalChild({ name: 'cwd', value: launch.cwd }),
  ...(launch.env === undefined
    ? []
    : [
        block({
          name: 'env',
          children: Object.entries(launch.env)
            .toSorted(([a], [b]) => a.localeCompare(b, 'en'))
            .map(([name, value]) => child({ name, value })),
        }),
      ]),
  ...(launch.unset === undefined ? [] : [node({ name: 'unset', args: launch.unset })]),
]

/** Decodes and renders a schedule node. */
export const schedule = (input: typeof ScheduleSchema.Encoded): Node => {
  const s = decode({ schema: ScheduleSchema, input })
  return node({
    name: 'schedule',
    args: [s.id],
    children: [
      child({ name: 'host', value: s.host }),
      ...(s.timing._tag === 'Calendar'
        ? [
            block({
              name: 'calendar',
              children: [
                child({
                  name: 'at',
                  value:
                    s.timing.days === undefined
                      ? s.timing.at
                      : `${s.timing.days[0]} ${s.timing.at}`,
                }),
                child({ name: 'timezone', value: s.timing.timezone }),
              ],
            }),
          ]
        : s.timing._tag === 'At'
          ? [child({ name: 'at', value: lowerInstant(s.timing.at) })]
          : [
              child({ name: 'every', value: lowerDuration(s.timing.every) }),
              child({ name: 'anchor', value: lowerInstant(s.timing.anchor) }),
            ]),
      ...(s.timing._tag === 'At' ? [] : [child({ name: 'catch-up', value: 'latest' })]),
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
        ...(g.review ?? []).map((target) => child({ name: 'review', value: lowerReview(target) })),
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
            ...optionalChild({ name: 'time-limit', value: nativeDuration(g.timeLimit) }),
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
  const snapshot = snapshotComposition(value)
  gateReferences.set(snapshot, Object.freeze([...references]))
  return snapshot
}
type AuthoredText = string | TextTemplate
type AuthoredGoal = AuthoredText | readonly [AuthoredText, ...AuthoredText[]]
type ReviewTarget = AuthoredText | DocumentReference | RunReference
type GateOptions = { readonly name?: AuthoredText }
type ExecutionOptions = {
  readonly host?: AuthoredText
  readonly workspace?: AuthoredText
  readonly timeLimit?: typeof Duration.Encoded
}
type Named<TGate extends { readonly name: string }> = Omit<TGate, 'name'> & GateOptions

/** A graph-field gate retaining the known field names of typed products. */
export type FieldIsInput<TFields extends ProductFields = ProductFields> = Omit<
  FieldGate,
  'kind' | 'operator' | 'subject' | 'path' | 'name' | 'value'
> &
  GateOptions & {
    readonly value: FieldGate['value'] | TextTemplate
  } & (
    | { readonly subject: AuthoredText | ResourceInput; readonly path: string }
    | {
        readonly subject: ProductHandle<TFields>
        readonly path: Extract<keyof NoInfer<TFields>, string>
      }
  )

const gateNameEncoder = new TextEncoder()
const derivedGateName = ({
  kind,
  identity,
  name,
}: {
  readonly kind: string
  readonly identity: string
  readonly name: AuthoredText | undefined
}): string => {
  if (name !== undefined) return templateText(name)
  const derived = `${kind}:${identity}`
  return utf8ByteLength(derived) <= 160
    ? derived
    : `${kind}:${bytesToHex(sha256(gateNameEncoder.encode(identity)))}`
}
const referencesInText = (value: AuthoredText): readonly RunReference[] =>
  typeof value === 'string' ? [] : templateReferences(value)
const referencesInName = (options: GateOptions): readonly RunReference[] =>
  options.name === undefined ? [] : referencesInText(options.name)
const targetText = (value: ReviewTarget): string => {
  if (typeof value === 'string') return value
  if ('kind' in value && value.kind === 'template') return templateText(value)
  if ('kind' in value && value.kind === 'document') return value.subject
  return referenceText(value)
}
const targetReferences = (value: ReviewTarget): readonly RunReference[] =>
  typeof value === 'string'
    ? []
    : 'kind' in value && (value.kind === 'template' || value.kind === 'document')
      ? templateReferences(value)
      : [value]
const executionFields = (
  options: ExecutionOptions,
): Pick<MergedGate, 'host' | 'workspace' | 'timeLimit'> => ({
  ...(options.host === undefined ? {} : { host: templateText(options.host) }),
  ...(options.workspace === undefined ? {} : { workspace: templateText(options.workspace) }),
  ...(options.timeLimit === undefined ? {} : { timeLimit: options.timeLimit }),
})
const executionReferences = (options: ExecutionOptions): readonly RunReference[] => [
  ...(options.host === undefined ? [] : referencesInText(options.host)),
  ...(options.workspace === undefined ? [] : referencesInText(options.workspace)),
]

const human = (
  input: Named<Omit<HumanGate, 'kind' | 'review' | 'question'>> & {
    readonly question?: AuthoredText
    readonly review?: readonly Review[]
  },
): HumanGate => {
  const { review, question, ...rest } = input
  const questionText = question === undefined ? undefined : templateText(question)
  return withReferences<HumanGate>({
    value: {
      ...rest,
      name: derivedGateName({
        kind: 'human',
        identity: `${input.reviewer.subject}:${questionText ?? ''}`,
        name: input.name,
      }),
      kind: 'human',
      ...(questionText === undefined ? {} : { question: questionText }),
      ...(review === undefined
        ? {}
        : { review: review.map((target) => decode({ schema: ReviewSchema, input: target })) }),
    },
    references: [
      ...referencesInName(input),
      ...(question === undefined ? [] : referencesInText(question)),
      ...(review ?? []).flatMap(reviewReferences),
    ],
  })
}

const exec = (
  input: Named<Omit<ExecGate, 'kind' | 'env' | 'command' | 'host' | 'workspace'>> & {
    readonly command: AuthoredText
    readonly host: AuthoredText
    readonly workspace: AuthoredText
    readonly env?: Readonly<Record<string, AuthoredText | RunReference>>
  },
): ExecGate => {
  const { env, command, host, workspace, ...rest } = input
  const commandText = templateText(command)
  const hostText = templateText(host)
  const workspaceText = templateText(workspace)
  return withReferences<ExecGate>({
    value: {
      ...rest,
      name: derivedGateName({
        kind: 'exec',
        identity: `${hostText}:${workspaceText}:${commandText}`,
        name: input.name,
      }),
      kind: 'exec',
      command: commandText,
      host: hostText,
      workspace: workspaceText,
      ...(env === undefined
        ? {}
        : {
            env: Object.fromEntries(
              Object.entries(env).map(([name, value]) => [name, targetText(value)]),
            ),
          }),
    },
    references: [
      ...referencesInName(input),
      ...referencesInText(command),
      ...referencesInText(host),
      ...referencesInText(workspace),
      ...Object.values(env ?? {}).flatMap(targetReferences),
    ],
  })
}

const fieldIs = <const TFields extends ProductFields>(input: FieldIsInput<TFields>): FieldGate => {
  const subject = targetText(input.subject)
  const value = typeof input.value === 'object' ? templateText(input.value) : input.value
  return withReferences<FieldGate>({
    value: {
      ...input,
      name: derivedGateName({
        kind: 'field',
        identity: `${subject}:${input.path}:${value}`,
        name: input.name,
      }),
      kind: 'field',
      operator: 'is',
      subject,
      value,
    },
    references: [
      ...referencesInName(input),
      ...targetReferences(input.subject),
      ...(typeof input.value === 'object' ? templateReferences(input.value) : []),
    ],
  })
}

const merged = ({
  target,
  ...options
}: GateOptions &
  ExecutionOptions & {
    readonly target: PullRequestReference | TextTemplate
  }): MergedGate => {
  const { host: _host, workspace: _workspace, ...rest } = options
  const locator =
    target.kind === 'pull-request' ? `${target.repo}#${target.number}` : templateText(target)
  return withReferences<MergedGate>({
    value: {
      ...rest,
      ...executionFields(options),
      name: derivedGateName({ kind: 'merged', identity: locator, name: options.name }),
      kind: 'merged',
      locator,
    },
    references: [
      ...referencesInName(options),
      ...executionReferences(options),
      ...(target.kind === 'pull-request' ? [] : templateReferences(target)),
    ],
  })
}

type CiPassedOptions = GateOptions &
  ExecutionOptions & { readonly repo: AuthoredText } & (
    | { readonly commit: AuthoredText | TextInput; readonly branch?: never }
    | { readonly branch: AuthoredText | TextInput; readonly commit?: never }
  )
const ciPassed = ({
  check,
  ...options
}: CiPassedOptions & { readonly check: AuthoredText }): CiPassedGate => {
  const { commit, branch, host: _host, workspace: _workspace, ...rest } = options
  const value = commit ?? branch
  if (value === undefined || (commit !== undefined && branch !== undefined))
    throw new TypeError('ciPassed requires exactly one commit or branch')
  const text =
    typeof value === 'string'
      ? value
      : isInputHandle(value) === true
        ? referenceText(value)
        : templateText(value)
  const checkText = templateText(check)
  const repo = templateText(options.repo)
  return withReferences<CiPassedGate>({
    value: {
      ...rest,
      ...executionFields(options),
      name: derivedGateName({
        kind: 'ci-passed',
        identity: `${repo}:${checkText}:${text}`,
        name: options.name,
      }),
      kind: 'ci-passed',
      repo,
      check: checkText,
      ref: commit === undefined ? { branch: text } : { commit: text },
    },
    references: [
      ...referencesInName(options),
      ...executionReferences(options),
      ...referencesInText(check),
      ...referencesInText(options.repo),
      ...(typeof value === 'string'
        ? []
        : isInputHandle(value) === true
          ? [value]
          : templateReferences(value)),
    ],
  })
}

/** Native gate constructors. Explicit names retain an existing gate's identity. */
export const gate = {
  human,
  exec,
  fieldIs,
  merged,
  ciPassed,
  document: ({
    target,
    ...options
  }: GateOptions & { readonly target: DocumentReference }): Extract<
    typeof GateSchema.Encoded,
    { readonly kind: 'document' }
  > =>
    withReferences<Extract<typeof GateSchema.Encoded, { readonly kind: 'document' }>>({
      value: {
        kind: 'document',
        name: derivedGateName({ kind: 'document', identity: target.subject, name: options.name }),
        subject: target.subject,
      },
      references: [...referencesInName(options), ...templateReferences(target)],
    }),
  exists: ({
    subject,
    ...options
  }: GateOptions & { readonly subject: ReviewTarget }): Extract<
    typeof GateSchema.Encoded,
    { readonly kind: 'exists' }
  > => {
    const rendered = targetText(subject)
    return withReferences<Extract<typeof GateSchema.Encoded, { readonly kind: 'exists' }>>({
      value: {
        kind: 'exists',
        name: derivedGateName({ kind: 'exists', identity: rendered, name: options.name }),
        subject: rendered,
      },
      references: [...referencesInName(options), ...targetReferences(subject)],
    })
  },
  empty: ({
    subject,
    ...options
  }: GateOptions & { readonly subject: AuthoredText }): Extract<
    typeof GateSchema.Encoded,
    { readonly kind: 'empty' }
  > => {
    const rendered = templateText(subject)
    return withReferences<Extract<typeof GateSchema.Encoded, { readonly kind: 'empty' }>>({
      value: {
        kind: 'empty',
        name: derivedGateName({ kind: 'empty', identity: rendered, name: options.name }),
        subject: rendered,
      },
      references: [...referencesInName(options), ...referencesInText(subject)],
    })
  },
  has: ({
    subject,
    text,
    ...options
  }: GateOptions & {
    readonly subject: ReviewTarget
    readonly text: AuthoredText
  }): Extract<typeof GateSchema.Encoded, { readonly kind: 'has' | 'lacks' }> => {
    const rendered = targetText(subject)
    const renderedText = templateText(text)
    return withReferences<Extract<typeof GateSchema.Encoded, { readonly kind: 'has' | 'lacks' }>>({
      value: {
        kind: 'has',
        name: derivedGateName({
          kind: 'has',
          identity: `${rendered}:${renderedText}`,
          name: options.name,
        }),
        subject: rendered,
        text: renderedText,
      },
      references: [
        ...referencesInName(options),
        ...targetReferences(subject),
        ...referencesInText(text),
      ],
    })
  },
  lacks: ({
    subject,
    text,
    ...options
  }: GateOptions & {
    readonly subject: ReviewTarget
    readonly text: AuthoredText
  }): Extract<typeof GateSchema.Encoded, { readonly kind: 'has' | 'lacks' }> => {
    const rendered = targetText(subject)
    const renderedText = templateText(text)
    return withReferences<Extract<typeof GateSchema.Encoded, { readonly kind: 'has' | 'lacks' }>>({
      value: {
        kind: 'lacks',
        name: derivedGateName({
          kind: 'lacks',
          identity: `${rendered}:${renderedText}`,
          name: options.name,
        }),
        subject: rendered,
        text: renderedText,
      },
      references: [
        ...referencesInName(options),
        ...targetReferences(subject),
        ...referencesInText(text),
      ],
    })
  },
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
          ...launchNodes(s.exec.launch),
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
          ...optionalChild({ name: 'backoff', value: nativeDuration(s.retry.backoff) }),
        ],
      }),
    )
  return node({
    name: 'step',
    args: [s.id],
    props: s.timeout === undefined ? {} : { timeout: lowerDuration(s.timeout) },
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
type AuthoredExec = Omit<typeof ExecSchema.Encoded, 'host' | 'workspace'> & {
  readonly host: AuthoredText
  readonly workspace: AuthoredText
}
type AuthoredStep = Omit<typeof StepSchema.Encoded, 'goal' | 'exec'> & {
  readonly goal?: AuthoredGoal
  readonly exec?: AuthoredExec
}
type Exhaustion = NonNullable<(typeof LoopSchema.Encoded)['onExhausted']>
type FailureExhaustion = Extract<Exhaustion, { readonly outcome: 'fail' }>
/** A loop retains authored native text until mission assembly. */
export type LoopInput = Omit<typeof LoopSchema.Encoded, 'round' | 'onExhausted'> & {
  readonly round: Omit<typeof RoundSchema.Encoded, 'steps' | 'finally'> & {
    readonly steps: readonly (AuthoredStep | StepHandle)[]
    readonly finally?: readonly [AuthoredStep | StepHandle, ...(AuthoredStep | StepHandle)[]]
  }
  readonly onExhausted?:
    | Extract<Exhaustion, { readonly outcome: 'succeed' }>
    | (Omit<FailureExhaustion, 'attention'> & {
        readonly attention?: Omit<NonNullable<FailureExhaustion['attention']>, 'title'> & {
          readonly title: AuthoredText
        }
      })
}
/** Step authoring data with scoped dependencies, resolved workers and named products. */
export type StepInput<TMission extends string, TProducts extends Products = Products> = Omit<
  AuthoredStep,
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
  'id' | 'goal' | 'steps' | 'finally' | 'inputs' | 'constraints'
> & {
  readonly id: TMission
  readonly goal: AuthoredGoal
  readonly constraints?: readonly AuthoredText[]
  readonly inputs?: readonly (InputHandle | typeof MissionInputSchema.Encoded)[]
  readonly steps: readonly (
    | ((AuthoredStep | LoopInput) & { readonly [stepBrand]?: never })
    | StepHandle<NoInfer<TMission>>
  )[]
  readonly finally?: readonly (
    | (AuthoredStep & { readonly [stepBrand]?: never })
    | StepHandle<NoInfer<TMission>>
  )[]
}

/** Snapshot plain authoring data, but never copy identities used by provenance WeakMaps. */
const snapshotComposition = <T>(input: T): T => {
  const copies = new WeakMap<object, object>()
  const snapshot = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value
    const prototype = Object.getPrototypeOf(value)
    if (
      (prototype !== Object.prototype && prototype !== null && Array.isArray(value) === false) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      gateReferences.has(value) === true ||
      templateReferences(value).length > 0 ||
      ('_tag' in value &&
        (((value._tag === 'Argv' || value._tag === 'Shell') &&
          launchReferences(value as Launch).length > 0) ||
          ((value._tag === 'Subject' || value._tag === 'File' || value._tag === 'PinnedDocument') &&
            reviewReferences(value as Review).length > 0))) ||
      ('kind' in value &&
        (value.kind === 'template' ||
          (value.kind === 'document' && !('name' in value)) ||
          value.kind === 'child-mission' ||
          value.kind === 'context' ||
          value.kind === 'pull-request')) ||
      ('_tag' in value && (value._tag === 'SubjectRef' || value._tag === 'PinnedMissionRef'))
    )
      return value
    const existing = copies.get(value)
    if (existing !== undefined) return existing
    const copy: object = Array.isArray(value) === true ? [] : Object.create(prototype)
    copies.set(value, copy)
    for (const [key, nested] of Object.entries(value))
      Object.defineProperty(copy, key, {
        value: snapshot(nested),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    return Object.freeze(copy)
  }
  return snapshot(input) as T
}

/** Immutable reusable graph fragments retain the exact scoped handle objects. */
export const Fragment = {
  steps: <const TSteps extends MissionInput<string>['steps']>(...steps: TSteps): Readonly<TSteps> =>
    snapshotComposition(steps),
}

const immutableMission = <const TMission extends string>(
  input: MissionInput<TMission>,
): MissionInput<TMission> => snapshotComposition(input)

/** Pure composition; references are checked by the single mission assembly boundary. */
export const Mission = {
  make: immutableMission,
  withSteps: <const TMission extends string>({
    mission: input,
    steps,
  }: {
    readonly mission: MissionInput<TMission>
    readonly steps: MissionInput<NoInfer<TMission>>['steps']
  }): MissionInput<TMission> => immutableMission({ ...input, steps: [...input.steps, ...steps] }),
  withFinally: <const TMission extends string>({
    mission: input,
    steps,
  }: {
    readonly mission: MissionInput<TMission>
    readonly steps: NonNullable<MissionInput<NoInfer<TMission>>['finally']>
  }): MissionInput<TMission> =>
    immutableMission({
      ...input,
      finally: [...(input.finally ?? []), ...steps],
    }),
}

/** A round fragment snapshots both phases without replacing scoped handles. */
export const Round = {
  make: (input: LoopInput['round']): LoopInput['round'] => snapshotComposition(input),
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
}): StepDependency<TMission> => Object.freeze({ [dependencyBrand]: true as const, handle, state })
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
  const childOutput =
    produces !== undefined && isChildMission(produces) === true ? produces : undefined
  const missionOutput =
    waitFor !== undefined && isStepHandle(waitFor) === true ? waitFor : undefined
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
          isStepHandle(dependsOn) === true
        ? [dependsOn]
        : dependsOn
  const dependencies: readonly StepDependency[] = dependencyInputs.flatMap((dependency) =>
    typeof dependency === 'string'
      ? []
      : dependencyBrand in dependency
        ? [dependency]
        : isStepHandle(dependency) === true
          ? [completed(dependency)]
          : [],
  )
  const seenProducts = new Set<ProductHandle>()
  const products = Object.freeze({
    ...(produces === undefined || isChildMission(produces) === true ? {} : produces),
  })
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
              fields: Object.fromEntries(
                Object.entries(value.fields).map(([name, field]) => [
                  name,
                  typeof field === 'object' ? templateText(field) : field,
                ]),
              ),
            })),
          }),
      ...(childOutput === undefined ? {} : { producesMission: childOutput.id }),
      ...(assignedTo === undefined ? {} : { assignedTo }),
      ...(goal === undefined ? {} : { goal: goalValues.map(templateText) }),
      ...(input.exec === undefined ? {} : { exec: authoredExecWire(input.exec) }),
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
                  : isStepHandle(dependency) === true
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
      ...authoredStepReferences(input),
      ...Object.values(products).flatMap((value) =>
        Object.values(value.fields).flatMap((field) =>
          typeof field === 'object' ? templateReferences(field) : [],
        ),
      ),
      ...(childOutput === undefined ? [] : templateReferences(childOutput)),
    ],
    ...(missionOutput === undefined ? {} : { missionOutput }),
  })
  return Object.freeze(handle)
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

const authoredExecWire = (value: AuthoredExec): typeof ExecSchema.Encoded => ({
  ...value,
  host: templateText(value.host),
  workspace: templateText(value.workspace),
})
const authoredStepReferences = (
  value: Pick<AuthoredStep, 'goal' | 'exec' | 'gates'>,
): readonly RunReference[] => [
  ...referencesInGates(value.gates),
  ...(value.goal === undefined
    ? []
    : typeof value.goal === 'string' || 'kind' in value.goal
      ? [value.goal]
      : value.goal
  ).flatMap(referencesInText),
  ...(value.exec === undefined
    ? []
    : [
        ...referencesInText(value.exec.host),
        ...referencesInText(value.exec.workspace),
        ...launchReferences(value.exec.launch),
      ]),
]
const authoredStepWire = (value: AuthoredStep | StepHandle): typeof StepSchema.Encoded => {
  if (isStepHandle(value) === true) return stepData.get(value)!.wire
  const { goal, exec: stepExec, ...rest } = value
  let wireGoal: typeof Goal.Encoded | undefined
  if (goal !== undefined) {
    const values: readonly [AuthoredText, ...AuthoredText[]] =
      typeof goal === 'string' || 'kind' in goal ? [goal] : goal
    const [first, ...remainingGoals] = values
    wireGoal = [templateText(first), ...remainingGoals.map(templateText)]
  }
  return {
    ...rest,
    ...(wireGoal === undefined ? {} : { goal: wireGoal }),
    ...(stepExec === undefined ? {} : { exec: authoredExecWire(stepExec) }),
  }
}
const authoredExhaustionWire = (value: NonNullable<LoopInput['onExhausted']>): Exhaustion => {
  if (value.outcome === 'succeed') return value
  const { attention, ...rest } = value
  return {
    ...rest,
    ...(attention === undefined
      ? {}
      : {
          attention: { ...attention, title: templateText(attention.title) },
        }),
  }
}
const authoredLoopWire = (value: LoopInput): typeof LoopSchema.Encoded => {
  const { onExhausted, ...rest } = value
  const { finally: finalSteps, ...round } = value.round
  return {
    ...rest,
    ...(onExhausted === undefined ? {} : { onExhausted: authoredExhaustionWire(onExhausted) }),
    round: {
      ...round,
      steps: round.steps.map(authoredStepWire),
      ...(finalSteps === undefined
        ? {}
        : {
            finally: [
              authoredStepWire(finalSteps[0]),
              ...finalSteps.slice(1).map(authoredStepWire),
            ] as const,
          }),
    },
  }
}

/** Lowers a loop and its explicitly completed round mission. */
export const loop = (input: LoopInput): Node => {
  if (
    loopReferences(input).length > 0 ||
    [...input.round.steps, ...(input.round.finally ?? [])].some(isStepHandle) === true
  )
    throw new TypeError('Typed references in loops require mission assembly')
  const l = decode({ schema: LoopSchema, input: authoredLoopWire(input) })
  return node({
    name: 'loop',
    args: [l.id],
    props: l.timeout === undefined ? {} : { timeout: lowerDuration(l.timeout) },
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
): readonly RunReference[] =>
  gates.flatMap(
    (value) =>
      gateReferences.get(value) ??
      (value.kind === 'human' ? (value.review ?? []).flatMap(reviewReferences) : []),
  )
const loopReferences = (input: LoopInput): readonly RunReference[] => [
  ...referencesInGates(input.until),
  ...input.round.steps.flatMap((value) =>
    isStepHandle(value) === true ? stepData.get(value)!.references : authoredStepReferences(value),
  ),
  ...(input.round.finally ?? []).flatMap((value) =>
    isStepHandle(value) === true ? stepData.get(value)!.references : authoredStepReferences(value),
  ),
  ...(input.onExhausted?.outcome !== 'fail' || input.onExhausted.attention === undefined
    ? []
    : referencesInText(input.onExhausted.attention.title)),
]

const assembleMission = <const TMission extends string>(
  input: MissionInput<TMission>,
): typeof MissionSchema.Type => {
  const phases: readonly (readonly object[])[] = [
    input.steps,
    input.finally ?? [],
    ...input.steps.flatMap((value) =>
      'round' in value ? [value.round.steps, value.round.finally ?? []] : [],
    ),
  ]
  const allHandles = phases.flatMap((phase) => phase.filter(isStepHandle))
  if (new Set(allHandles).size !== allHandles.length)
    throw new TypeError('A step handle can occur in only one mission phase')
  const referenced = [
    ...referencesInGates(input.gates),
    ...(typeof input.goal === 'string' || 'kind' in input.goal ? [input.goal] : input.goal).flatMap(
      referencesInText,
    ),
    ...(input.constraints ?? []).flatMap(referencesInText),
    ...[...input.steps, ...(input.finally ?? [])].flatMap((value) =>
      isStepHandle(value) === true
        ? stepData.get(value)!.references
        : 'round' in value
          ? loopReferences(value)
          : authoredStepReferences(value),
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
  // A loop round is its own native mission. Equal IDs or membership in the
  // outer declaration must not let an attempt-bound product escape that scope.
  const validateProductScope = ({
    references,
    handles,
  }: {
    readonly references: readonly RunReference[]
    readonly handles: readonly object[]
  }): void => {
    for (const ref of references) {
      if (isInputHandle(ref) === false && handles.includes(productOwners.get(ref)!) === false)
        throw new TypeError('Product reference belongs to a step outside this mission scope')
    }
  }
  const outerSteps = [...input.steps, ...(input.finally ?? [])]
  const outerHandles = outerSteps.filter(isStepHandle)
  validateProductScope({
    references: [
      ...referencesInGates(input.gates),
      ...(typeof input.goal === 'string' || 'kind' in input.goal
        ? [input.goal]
        : input.goal
      ).flatMap(referencesInText),
      ...(input.constraints ?? []).flatMap(referencesInText),
      ...outerSteps.flatMap((value) =>
        isStepHandle(value) === true
          ? stepData.get(value)!.references
          : 'round' in value
            ? []
            : authoredStepReferences(value),
      ),
    ],
    handles: outerHandles,
  })
  for (const value of input.steps) {
    if ('round' in value) {
      validateProductScope({
        references: loopReferences(value),
        handles: [...value.round.steps, ...(value.round.finally ?? [])].filter(isStepHandle),
      })
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
    const phase = phases.find((candidate) => candidate.includes(handle))!
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
      ...(input.constraints === undefined
        ? {}
        : { constraints: input.constraints.map(templateText) }),
      ...(input.inputs === undefined
        ? {}
        : {
            inputs: input.inputs.map((value) =>
              isInputHandle(value) === true ? { name: value.name, kind: value.kind } : value,
            ),
          }),
      steps: input.steps.map((s) =>
        isStepHandle(s) === true
          ? stepData.get(s)!.wire
          : 'round' in s
            ? authoredLoopWire(s)
            : authoredStepWire(s),
      ),
      ...(input.finally === undefined
        ? {}
        : {
            finally: input.finally.map((s) =>
              isStepHandle(s) === true ? stepData.get(s)!.wire : authoredStepWire(s),
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
    } else if (Array.isArray(value) === true) {
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
      ...(m.timeout === undefined ? {} : { timeout: lowerDuration(m.timeout) }),
      ...(m.stalledAfter === undefined ? {} : { 'stalled-after': lowerDuration(m.stalledAfter) }),
      ...(m.reportStalls === undefined ? {} : { 'report-stalls': m.reportStalls }),
      ...(m.reportCompleted === undefined ? {} : { 'report-completed': m.reportCompleted }),
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
      ...(m.lanes ?? []).map((lane) =>
        node({
          name: 'lane',
          args: [lane.name],
          children: [
            ...optionalChild({ name: 'entries', value: lane.entries }),
            ...optionalChild({ name: 'approver', value: lane.approver }),
          ],
        }),
      ),
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
      ...launchNodes(task.launch),
    ],
  })

/** Decodes and renders an agent seat node. */
export const agent = (input: typeof AgentSchema.Encoded): Node => {
  const a = decode({ schema: AgentSchema, input })
  const children: Node[] = [
    ...optionalChild({ name: 'identity', value: a.identity }),
    ...optionalChild({ name: 'name', value: a.name }),
    ...optionalChild({ name: 'description', value: a.description }),
    ...optionalChild({ name: 'principal', value: a.principal?.subject }),
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
    ...optionalChild({ name: 'shutdown-timeout', value: nativeDuration(a.shutdownTimeout) }),
  )
  if (a.launch !== undefined) children.push(...launchNodes(a.launch))
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
          ...(a.harness.effort === undefined
            ? []
            : [child({ name: 'effort', value: a.harness.effort })]),
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

/** Genie output for a Fractal KDL declaration file. */
export const fractalKdl = (nodes: readonly Node[]): GenieOutput<readonly Node[]> => ({
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
          packageName: '@overeng/genie-fractal',
          dependency: '',
          rule: 'fractal-kdl',
          message: cause instanceof Error ? cause.message : String(cause),
        },
      ]
    }
  },
})
