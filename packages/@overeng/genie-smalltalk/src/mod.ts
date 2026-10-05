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

/** A step gate on an exit code or subject state. */
export const GateSchema = Schema.Struct({
  name: Text,
  field: Schema.Struct({
    kind: Schema.Literals(['exit_code', 'state']),
    ref: Text,
    is: Schema.Union([Schema.String, Schema.Finite]),
  }),
}).annotate({ identifier: 'St.Gate' })

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
  state: Schema.Literal('completed'),
}).annotate({
  identifier: 'St.DependsOn',
})

/** One mission step. */
export const StepSchema = Schema.Struct({
  id: LocalId,
  timeout: Schema.optionalKey(Duration),
  agentless: Schema.optionalKey(Schema.Literal(true)),
  assignedTo: Schema.optionalKey(SubjectId),
  dependsOn: Schema.optionalKey(DependsOnSchema),
  goal: Schema.optionalKey(Text),
  exec: Schema.optionalKey(ExecSchema),
  gate: Schema.optionalKey(GateSchema),
}).pipe(
  Schema.refine(
    (s): s is typeof s => (s.agentless === true && s.assignedTo !== undefined) === false,
    {
      message: 'agentless and assigned-to conflict',
    },
  ),
  Schema.annotate({ identifier: 'St.Step' }),
)

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
  state: Schema.Literal('ready'),
  timeout: Schema.optionalKey(Duration),
  goal: Text,
  constraints: Schema.optionalKey(Schema.Array(Text)),
  steps: Schema.Array(StepSchema),
  schedule: Schema.optionalKey(ScheduleSchema),
}).pipe(
  Schema.refine(
    (m): m is typeof m =>
      m.steps.length > 0 &&
      new Set(m.steps.map((s) => s.id)).size === m.steps.length &&
      m.steps.every(
        (s) => s.dependsOn === undefined || m.steps.some((p) => p.id === s.dependsOn?.step),
      ),
    { message: 'mission needs unique steps and existing dependencies' },
  ),
  Schema.annotate({ identifier: 'St.Mission' }),
)

/** A typed st resource. */
export const ResourceSchema = Schema.Struct({
  id: SubjectId,
  kind: Schema.Literals(['vcs.repository', 'filesystem.file', 'vcs.pull-request']),
}).annotate({ identifier: 'St.Resource' })

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

/** Decodes and renders a step node. */
export const step = (input: typeof StepSchema.Encoded): Node => {
  const s = decode({ schema: StepSchema, input })
  const children: Node[] = []
  if (s.agentless === true) children.push(node({ name: 'agentless' }))
  if (s.assignedTo !== undefined) children.push(child({ name: 'assigned-to', value: s.assignedTo }))
  if (s.dependsOn !== undefined) {
    children.push(
      block({
        name: 'depends-on',
        children: [node({ name: 'step', args: [s.dependsOn.step, s.dependsOn.state] })],
      }),
    )
  }
  if (s.goal !== undefined) children.push(child({ name: 'goal', value: s.goal }))
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
  if (s.gate !== undefined) {
    const field = s.gate.field
    children.push(
      node({
        name: 'gate',
        args: [s.gate.name],
        children: [node({ name: 'field', args: [field.kind, field.ref, 'is', field.is] })],
      }),
    )
  }
  return node({
    name: 'step',
    args: [s.id],
    props: s.timeout === undefined ? {} : { timeout: s.timeout },
    children,
  })
}

/** Decodes and renders a mission node with its schedule and steps. */
export const mission = (input: typeof MissionSchema.Encoded): Node => {
  const m = decode({ schema: MissionSchema, input })
  return node({
    name: 'mission',
    args: [m.id],
    props: { state: m.state, ...(m.timeout === undefined ? {} : { timeout: m.timeout }) },
    children: [
      child({ name: 'goal', value: m.goal }),
      ...(m.constraints ?? []).map((constraint) =>
        child({ name: 'constraint', value: constraint }),
      ),
      ...(m.schedule === undefined ? [] : [schedule(m.schedule)]),
      ...m.steps.map(step),
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
