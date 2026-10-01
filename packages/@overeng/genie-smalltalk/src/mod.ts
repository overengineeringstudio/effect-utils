import { Schema } from 'effect'
import type { GenieOutput } from '@overeng/genie'

export type Value = string | number | boolean
export type Node = { readonly name: string; readonly args: readonly Value[]; readonly props: Readonly<Record<string, Value>>; readonly children?: readonly Node[] }
export const node = (name: string, args: readonly Value[] = [], props: Readonly<Record<string, Value>> = {}, children?: readonly Node[]): Node => ({ name, args, props, ...(children === undefined ? {} : { children }) })
const value = (v: Value): string => typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? `#${v}` : Number.isFinite(v) ? String(v) : (() => { throw new RangeError('KDL numbers must be finite') })()
const identifier = (s: string): string => /^[A-Za-z_][\w-]*$/u.test(s) ? s : JSON.stringify(s)
const render = (n: Node, depth: number): string => {
  const pad = '  '.repeat(depth)
  const header = `${pad}${identifier(n.name)}${n.args.map(v => ` ${value(v)}`).join('')}${Object.entries(n.props).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => ` ${identifier(k)}=${value(v)}`).join('')}`
  return n.children === undefined ? `${header}\n` : `${header} {\n${n.children.map(c => render(c, depth + 1)).join('')}${pad}}\n`
}
export const emit = (nodes: readonly Node[]): string => `version 2\n${nodes.map(n => render(n, 0)).join('')}`
const child = (name: string, arg: Value): Node => node(name, [arg])
const block = (name: string, children: readonly Node[]): Node => node(name, [], {}, children)
const Text = Schema.NonEmptyString
const SubjectId = Schema.String.pipe(Schema.refine((s): s is string => s.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(s) && !s.endsWith('/') && !s.split('/').some(p => p === '..'), { message: 'invalid st subject ID' }), Schema.brand('SubjectId'))
const LocalId = Schema.String.pipe(Schema.refine((s): s is string => s.length > 0 && s.length <= 160 && !/[\s/]/u.test(s), { message: 'invalid local ID' }), Schema.brand('LocalId'))
const MissionId = Schema.String.pipe(Schema.refine((s): s is string => s.length > 0 && s.length <= 160 && !s.startsWith('/') && !s.endsWith('/') && !s.includes('//') && !/\s/u.test(s), { message: 'invalid mission ID' }), Schema.brand('MissionId'))
const Duration = Schema.String.pipe(Schema.refine((s): s is string => { const m = /^(\d+)(ms|s|m|h|d)$/u.exec(s); if (!m) return false; const scale = { ms: 1n, s: 1000n, m: 60000n, h: 3600000n, d: 86400000n }; const n = BigInt(m[1]!) * scale[m[2] as keyof typeof scale]; return n > 0n && n <= 18446744073709551615n }, { message: 'invalid positive st duration' }), Schema.brand('Duration'))
const UtcAnchor = Schema.String.pipe(Schema.refine((s): s is string => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 19) === s.slice(0, 19), { message: 'invalid UTC anchor' }), Schema.brand('UtcAnchor'))
const Revision = Schema.String.pipe(Schema.refine((s): s is string => /^[^@\s/][^@\s]*@[a-fA-F0-9]{64}$/u.test(s) && !s.slice(0, s.lastIndexOf('@')).endsWith('/'), { message: 'expected mission@64-hex revision' }), Schema.brand('Revision'))
const Restart = Schema.Literals(['never', 'always'])
const Env = Schema.Record(Schema.String, Schema.String)
const Authority = Schema.Array(Schema.Struct({ verb: Text, pattern: Text }))
const AgentTask = Schema.Struct({ id: LocalId, host: Schema.optionalKey(Text), workspace: Schema.optionalKey(Text), command: Schema.optionalKey(Text), argv: Schema.optionalKey(Schema.Array(Text)), restart: Schema.optionalKey(Restart) }).pipe(Schema.refine((t): t is typeof t => Number(t.command !== undefined) + Number(t.argv !== undefined) === 1, { message: 'task needs exactly one launch form' }))
const RenderOperation = Schema.Struct({ kind: Schema.Literals(['copy', 'file', 'json-upsert']), destination: Text, content: Text, executable: Schema.optionalKey(Schema.Boolean), arrays: Schema.optionalKey(Schema.Literals(['replace', 'union'])) })
export const OmpSchema = Schema.Struct({ kind: Schema.Literal('omp'), model: Text, effort: Schema.Literals(['low', 'medium', 'high']) }).annotate({ identifier: 'St.Omp' })
export const AgentSchema = Schema.Struct({
  id: SubjectId, identity: Schema.optionalKey(Text), name: Schema.optionalKey(Text), description: Schema.optionalKey(Text), host: Schema.optionalKey(Text),
  workspace: Schema.optionalKey(Text), create: Schema.optionalKey(Schema.Boolean), checkout: Schema.optionalKey(Schema.Struct({ repository: Text, base: Text, branch: Text, removeAtRunEnd: Schema.optionalKey(Schema.Boolean) })),
  under: Schema.optionalKey(Schema.Array(Schema.Struct({ target: Text, reason: Schema.optionalKey(Text) }))), restart: Schema.optionalKey(Restart),
  shutdownTimeout: Schema.optionalKey(Duration), command: Schema.optionalKey(Text), argv: Schema.optionalKey(Schema.Array(Text)), env: Schema.optionalKey(Env), render: Schema.optionalKey(Schema.Array(RenderOperation)),
  harness: Schema.optionalKey(OmpSchema), freshContext: Schema.optionalKey(Schema.Literal(true)), missionAuthority: Schema.optionalKey(Authority), queueAuthority: Schema.optionalKey(Authority), seatAuthority: Schema.optionalKey(Authority),
  pty: Schema.optionalKey(Schema.Array(AgentTask)), exec: Schema.optionalKey(Schema.Array(AgentTask)),
}).pipe(Schema.refine((a): a is typeof a => (!a.checkout || !!a.workspace) && (!a.create || !!a.workspace) && (!a.name || a.name.length <= 160) && (!a.description || a.description.length <= 1000) && Number(a.command !== undefined) + Number(a.argv !== undefined) + Number(a.harness !== undefined) <= 1 && (!a.env || Object.keys(a.env).every(k => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(k))) && (!a.render || a.render.length > 0) && [a.missionAuthority, a.queueAuthority, a.seatAuthority].every(rules => !rules || rules.length > 0), { message: 'invalid agent declaration' }), Schema.annotate({ identifier: 'St.Agent' }))
export const GateSchema = Schema.Struct({ name: Text, field: Schema.Struct({ kind: Schema.Literals(['exit_code', 'state']), ref: Text, is: Schema.Union([Schema.String, Schema.Number]) }) }).annotate({ identifier: 'St.Gate' })
export const ExecSchema = Schema.Struct({ id: LocalId, host: Text, workspace: Text, command: Text, restart: Restart }).annotate({ identifier: 'St.Exec' })
export const DependsOnSchema = Schema.Struct({ step: LocalId, state: Schema.Literal('completed') }).annotate({ identifier: 'St.DependsOn' })
export const StepSchema = Schema.Struct({ id: LocalId, timeout: Schema.optionalKey(Duration), agentless: Schema.optionalKey(Schema.Literal(true)), assignedTo: Schema.optionalKey(SubjectId), dependsOn: Schema.optionalKey(DependsOnSchema), goal: Schema.optionalKey(Text), exec: Schema.optionalKey(ExecSchema), gate: Schema.optionalKey(GateSchema) }).pipe(Schema.refine((s): s is typeof s => !(s.agentless && s.assignedTo), { message: 'agentless and assigned-to conflict' }), Schema.annotate({ identifier: 'St.Step' }))
export const WorkSchema = Schema.Struct({ mission: Revision, workspace: Text }).annotate({ identifier: 'St.Work' })
export const ScheduleSchema = Schema.Struct({ id: LocalId, host: Schema.Literal('local'), every: Duration, anchor: UtcAnchor, catchUp: Schema.Literal('latest'), work: WorkSchema }).annotate({ identifier: 'St.Schedule' })
export const MissionSchema = Schema.Struct({ id: MissionId, state: Schema.Literal('ready'), timeout: Schema.optionalKey(Duration), goal: Text, constraints: Schema.optionalKey(Schema.Array(Text)), steps: Schema.Array(StepSchema), schedule: Schema.optionalKey(ScheduleSchema) }).pipe(Schema.refine((m): m is typeof m => m.steps.length > 0 && new Set(m.steps.map(s => s.id)).size === m.steps.length && m.steps.every(s => !s.dependsOn || m.steps.some(p => p.id === s.dependsOn?.step)), { message: 'mission needs unique steps and existing dependencies' }), Schema.annotate({ identifier: 'St.Mission' }))
export const ResourceSchema = Schema.Struct({ id: SubjectId, kind: Schema.Literals(['vcs.repository', 'filesystem.file', 'vcs.pull-request']) }).annotate({ identifier: 'St.Resource' })
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
export const omp = (model: string, effort: 'low' | 'medium' | 'high'): typeof OmpSchema.Type => decode(OmpSchema, { kind: 'omp', model, effort })
export const resource = (input: typeof ResourceSchema.Encoded): Node => { const r = decode(ResourceSchema, input); return node('resource', [r.id], {}, [child('kind', r.kind)]) }
export const schedule = (input: typeof ScheduleSchema.Encoded): Node => { const s = decode(ScheduleSchema, input); return node('schedule', [s.id], {}, [child('host', s.host), child('every', s.every), child('anchor', s.anchor), child('catch-up', s.catchUp), block('work', [child('mission', s.work.mission), child('workspace', s.work.workspace)])]) }
export const step = (input: typeof StepSchema.Encoded): Node => { const s = decode(StepSchema, input); return node('step', [s.id], s.timeout ? { timeout: s.timeout } : {}, [...(s.agentless ? [node('agentless')] : []), ...(s.assignedTo ? [child('assigned-to', s.assignedTo)] : []), ...(s.dependsOn ? [block('depends-on', [node('step', [s.dependsOn.step, s.dependsOn.state])])] : []), ...(s.goal ? [child('goal', s.goal)] : []), ...(s.exec ? [node('exec', [s.exec.id], {}, [child('host', s.exec.host), child('workspace', s.exec.workspace), child('command', s.exec.command), child('restart', s.exec.restart)])] : []), ...(s.gate ? [node('gate', [s.gate.name], {}, [node('field', [s.gate.field.kind, s.gate.field.ref, 'is', s.gate.field.is])])] : [])]) }
export const mission = (input: typeof MissionSchema.Encoded): Node => { const m = decode(MissionSchema, input); return node('mission', [m.id], { state: m.state, ...(m.timeout ? { timeout: m.timeout } : {}) }, [child('goal', m.goal), ...(m.constraints ?? []).map(c => child('constraint', c)), ...(m.schedule ? [schedule(m.schedule)] : []), ...m.steps.map(step)]) }
export const agent = (input: typeof AgentSchema.Encoded): Node => {
  const a = decode(AgentSchema, input)
  const optional = (name: string, v: string | undefined): Node[] => v === undefined ? [] : [child(name, v)]
  return node('agent', [a.id], {}, [
    ...optional('identity', a.identity), ...optional('name', a.name), ...optional('description', a.description), ...optional('host', a.host),
    ...(a.workspace ? [node('workspace', [a.workspace], a.create === undefined ? {} : { create: a.create })] : []),
    ...(a.checkout ? [node('checkout', [a.checkout.repository], { base: a.checkout.base, branch: a.checkout.branch, ...(a.checkout.removeAtRunEnd === undefined ? {} : { 'remove-at-run-end': a.checkout.removeAtRunEnd }) })] : []),
    ...(a.under ?? []).map(u => node('under', [u.target], u.reason ? { reason: u.reason } : {})), ...optional('restart', a.restart), ...optional('shutdown-timeout', a.shutdownTimeout), ...optional('command', a.command),
    ...(a.argv ? [node('argv', a.argv)] : []), ...(a.env ? [block('env', Object.entries(a.env).sort(([x], [y]) => x.localeCompare(y, 'en')).map(([k, v]) => child(k, v)))] : []),
    ...(a.render ? [block('render', a.render.map(op => node(op.kind, [op.destination, op.content], { ...(op.executable === undefined ? {} : { executable: op.executable }), ...(op.arrays === undefined ? {} : { arrays: op.arrays }) })))] : []),
    ...(a.harness ? [node('harness', [a.harness.kind], {}, [child('model', a.harness.model), child('effort', a.harness.effort)])] : []),
    ...(a.freshContext ? [node('fresh-context')] : []),
    ...(['missionAuthority', 'queueAuthority', 'seatAuthority'] as const).flatMap(k => a[k] ? [block(k.replace(/[A-Z]/gu, c => `-${c.toLowerCase()}`), a[k].map(v => child(v.verb, v.pattern)))] : []),
    ...(['pty', 'exec'] as const).flatMap(kind => (a[kind] ?? []).map(t => node(kind, [t.id], {}, [...optional('host', t.host), ...optional('workspace', t.workspace), ...optional('command', t.command), ...(t.argv ? [node('argv', t.argv)] : []), ...optional('restart', t.restart)]))),
  ])
}
export const smalltalkKdl = (nodes: readonly Node[]): GenieOutput<readonly Node[]> => ({
  data: nodes,
  stringify: () => emit(nodes),
  validate: () => {
    try {
      emit(nodes)
      return []
    } catch (cause) {
      return [{ severity: 'error', packageName: '@overeng/genie-smalltalk', dependency: '', rule: 'smalltalk-kdl', message: cause instanceof Error ? cause.message : String(cause) }]
    }
  },
})
