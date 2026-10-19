import { Schema } from 'effect'

import {
  CalendarDaysSchema,
  CalendarTimeSchema,
  PinnedDocumentReferenceSchema,
  EveryScheduleSchema,
  ExecSchema,
  FullSubject,
  IanaTimezoneSchema,
  MissionSchema,
  StepSchema,
  WorkSchema,
  mission as nativeMission,
  node,
  type Node,
} from './mod.ts'

/** Scratch APIs: native declarations remain the lossless escape hatch, not a second grammar. */
export type NativeMission = typeof MissionSchema.Encoded
export type NativeStep = typeof StepSchema.Encoded

const Text = Schema.NonEmptyString
const EnvironmentName = Schema.String.pipe(
  Schema.refine((value): value is string => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)),
)
const Environment = Schema.Record(EnvironmentName, Schema.String)
const launchFields = {
  env: Schema.optionalKey(Environment),
  unset: Schema.optionalKey(Schema.Array(EnvironmentName)),
  cwd: Schema.optionalKey(Text),
}
export const LaunchSchema = Schema.Union([
  Schema.TaggedStruct('argv', { argv: Schema.NonEmptyArray(Schema.String), ...launchFields }),
  Schema.TaggedStruct('shell', { command: Text, ...launchFields }),
]).pipe(
  Schema.refine((value): value is typeof value =>
    (value.unset ?? []).every((name) => value.env?.[name] === undefined),
    { message: 'launch cannot set and unset the same environment name' },
  ),
).annotate({ identifier: 'Bakeoff.Launch' })
export type Launch = typeof LaunchSchema.Encoded
export type LaunchOptions = Pick<Launch, 'env' | 'unset' | 'cwd'>

export const CatchUpSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(['latest', 'skip']) }),
  Schema.Struct({
    kind: Schema.Literal('all'),
    max: Schema.Int.pipe(Schema.refine((value): value is number => value > 0 && value <= 4294967295)),
  }),
]).annotate({ identifier: 'Bakeoff.CatchUp' })
export type CatchUp = typeof CatchUpSchema.Encoded
export const TimingSchema = Schema.Union([
  Schema.TaggedStruct('at', { at: EveryScheduleSchema.fields.anchor }),
  Schema.TaggedStruct('every', {
    every: EveryScheduleSchema.fields.every,
    anchor: EveryScheduleSchema.fields.anchor,
    catchUp: Schema.optionalKey(CatchUpSchema),
  }),
  Schema.TaggedStruct('calendar', {
    at: CalendarTimeSchema,
    timezone: IanaTimezoneSchema,
    days: Schema.optionalKey(CalendarDaysSchema),
    catchUp: Schema.optionalKey(CatchUpSchema),
  }),
]).annotate({ identifier: 'Bakeoff.Timing' })
export type Timing = typeof TimingSchema.Encoded

export const ReviewSchema = Schema.Union([
  Schema.TaggedStruct('subject', { subject: FullSubject }),
  Schema.TaggedStruct('document', { reference: PinnedDocumentReferenceSchema }),
]).annotate({ identifier: 'Bakeoff.Review' })
export type Review = typeof ReviewSchema.Encoded

/** These slots are intentionally rejected until native enforcement exists. */
export interface UnsupportedPolicy {
  readonly policy?: unknown
  readonly hardTimeout?: string
  readonly consent?: unknown
}
export class UnsupportedLowering extends TypeError {
  readonly _tag = 'UnsupportedLowering'
  readonly feature: string
  constructor(feature: string) {
    super(`Native lowering does not support ${feature}; no declaration was emitted`)
    this.feature = feature
  }
}
const rejectUnsupported = (input: UnsupportedPolicy): void => {
  for (const field of ['policy', 'hardTimeout', 'consent'] as const) {
    if (input[field] !== undefined) throw new UnsupportedLowering(field)
  }
}
const validate = <TSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: TSchema,
  input: TSchema['Encoded'],
): TSchema['Encoded'] => {
  Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  return input
}

export const ExecPrototypeSchema = Schema.Struct({
  id: ExecSchema.fields.id,
  host: ExecSchema.fields.host,
  workspace: ExecSchema.fields.workspace,
  restart: ExecSchema.fields.restart,
  launch: LaunchSchema,
}).annotate({ identifier: 'Bakeoff.Exec' })
export type Exec = typeof ExecPrototypeSchema.Encoded
export const SchedulePrototypeSchema = Schema.Struct({
  id: EveryScheduleSchema.fields.id,
  host: Schema.Literal('local'),
  work: WorkSchema,
  timing: TimingSchema,
}).annotate({ identifier: 'Bakeoff.Schedule' })
export type Schedule = typeof SchedulePrototypeSchema.Encoded
export interface StepFragment extends UnsupportedPolicy {
  readonly native: NativeStep
  readonly launch?: Launch
  readonly review?: readonly Review[]
}
export interface MissionOptions extends UnsupportedPolicy {
  readonly steps?: readonly StepFragment[]
  readonly finally?: readonly StepFragment[]
  readonly schedule?: Schedule
}
export interface Mission extends MissionOptions {
  readonly native: NativeMission
}

const makeStep = (input: StepFragment): StepFragment => {
  rejectUnsupported(input)
  validate(StepSchema, input.native)
  if (input.launch !== undefined) {
    validate(LaunchSchema, input.launch)
    if (input.native.exec === undefined) throw new TypeError('A launch override requires a native exec')
  }
  if (input.review !== undefined) {
    for (const review of input.review) validate(ReviewSchema, review)
    if (input.native.gates?.some((gate) => gate.kind === 'human') !== true)
      throw new TypeError('Review targets require a human gate')
  }
  return input
}
const reviewText = (review: Review): string => review._tag === 'subject' ? review.subject : review.reference
const stepWire = (fragment: StepFragment): NativeStep => {
  makeStep(fragment)
  if (fragment.review === undefined) return fragment.native
  const review = fragment.review.map(reviewText)
  return {
    ...fragment.native,
    gates: (fragment.native.gates ?? []).map((gate) => gate.kind === 'human'
      ? { ...gate, review }
      : gate),
  }
}
const missionWire = (input: Mission): NativeMission => {
  rejectUnsupported(input)
  const { schedule: originalSchedule, ...native } = input.native
  const steps = input.steps === undefined ? native.steps : input.steps.map(stepWire)
  const finalSteps = input.finally === undefined ? native.finally : input.finally.map(stepWire)
  if (finalSteps !== undefined && finalSteps.length === 0) throw new TypeError('Finally must be nonempty')
  const wire: NativeMission = {
    ...native,
    steps,
    ...(finalSteps === undefined ? {} : { finally: [finalSteps[0]!, ...finalSteps.slice(1)] }),
    ...(input.schedule === undefined && originalSchedule !== undefined ? { schedule: originalSchedule } : {}),
  }
  validate(MissionSchema, wire)
  return wire
}
const makeMission = (input: Mission): Mission => {
  missionWire(input)
  if (input.schedule !== undefined) validate(SchedulePrototypeSchema, input.schedule)
  return input
}

const leaf = (name: string, value: string | number): Node => node({ name, args: [value] })
/** Native members accept command OR argv and env/unset/cwd, without shell interpolation of argv. */
export const renderExec = (input: Exec & UnsupportedPolicy): Node => {
  rejectUnsupported(input)
  const value = validate(ExecPrototypeSchema, input)
  const launch = value.launch
  return node({ name: 'exec', args: [value.id], children: [
    leaf('host', value.host),
    leaf('workspace', value.workspace),
    ...(launch._tag === 'argv' ? [node({ name: 'argv', args: launch.argv })] : [leaf('command', launch.command)]),
    ...(launch.cwd === undefined ? [] : [leaf('cwd', launch.cwd)]),
    ...(launch.env === undefined ? [] : [node({ name: 'env', children: Object.entries(launch.env).map(([name, value]) => leaf(name, value)) })]),
    ...(launch.unset === undefined ? [] : [node({ name: 'unset', args: launch.unset })]),
    leaf('restart', value.restart),
  ] })
}
export const renderSchedule = (input: Schedule & UnsupportedPolicy): Node => {
  rejectUnsupported(input)
  const value = validate(SchedulePrototypeSchema, input)
  const timing = value.timing
  const catchUp = timing._tag === 'at' ? undefined : timing.catchUp
  return node({ name: 'schedule', args: [value.id], children: [
    leaf('host', value.host),
    ...(timing._tag === 'at' ? [leaf('at', timing.at)] : timing._tag === 'every'
      ? [leaf('every', timing.every), leaf('anchor', timing.anchor)]
      : [node({ name: 'calendar', children: [
          leaf('at', timing.days === undefined ? timing.at : `${timing.days[0]} ${timing.at}`),
          leaf('timezone', timing.timezone),
        ] })]),
    ...(catchUp === undefined ? [] : [leaf('catch-up', catchUp.kind), ...(catchUp.kind === 'all' ? [leaf('max-catch-up', catchUp.max)] : [])]),
    node({ name: 'work', children: [leaf('mission', value.work.mission), leaf('workspace', value.work.workspace)] }),
  ] })
}
/** Existing renderer owns all native fields; only explicitly redesigned fragments are replaced. */
export const renderMission = (input: Mission): Node => {
  const wire = missionWire(input)
  const base = nativeMission(wire)
  const replaceStep = (current: Node, fragments: readonly StepFragment[] | undefined): Node => {
    const fragment = fragments?.find((fragment) => fragment.native.id === current.args[0])
    if (fragment?.launch === undefined || fragment.native.exec === undefined) return current
    const { id, host, workspace, restart } = fragment.native.exec
    const exec = renderExec({ id, host, workspace, restart, launch: fragment.launch })
    return { ...current, children: current.children?.map((child) => child.name === 'exec' ? exec : child) }
  }
  return { ...base, children: [
    ...(base.children ?? []).map((current) => current.name === 'step'
      ? replaceStep(current, input.steps)
      : current.name === 'finally'
        ? { ...current, children: current.children?.map((step) => replaceStep(step, input.finally)) }
        : current),
    ...(input.schedule === undefined ? [] : [renderSchedule(input.schedule)]),
  ] }
}

const launch = {
  argv: (argv: readonly [string, ...string[]], options: LaunchOptions = {}): Launch =>
    validate(LaunchSchema, { _tag: 'argv', argv, ...options }),
  shell: (command: string, options: LaunchOptions = {}): Launch =>
    validate(LaunchSchema, { _tag: 'shell', command, ...options }),
}
const timing = {
  at: (at: string): Timing => validate(TimingSchema, { _tag: 'at', at }),
  every: (every: string, anchor: string, catchUp?: CatchUp): Timing =>
    validate(TimingSchema, { _tag: 'every', every, anchor, ...(catchUp === undefined ? {} : { catchUp }) }),
  calendar: (input: Omit<Extract<Timing, { readonly _tag: 'calendar' }>, '_tag'>): Timing =>
    validate(TimingSchema, { _tag: 'calendar', ...input }),
}
const review = {
  subject: (subject: string): Review => validate(ReviewSchema, { _tag: 'subject', subject }),
  document: (reference: string): Review => validate(ReviewSchema, { _tag: 'document', reference }),
}
/** A: nested value-oriented configuration, with independently reusable step fragments. */
export const DesignA = {
  launch, timing, review,
  exec: (input: Exec & UnsupportedPolicy): Exec => { rejectUnsupported(input); return validate(ExecPrototypeSchema, input) },
  schedule: (input: Schedule & UnsupportedPolicy): Schedule => { rejectUnsupported(input); return validate(SchedulePrototypeSchema, input) },
  step: makeStep,
  mission: makeMission,
}

const nativeLaunchFields = { ...launchFields }
export const NativeLaunchSchema = Schema.Union([
  Schema.Struct({ command: Text, ...nativeLaunchFields }),
  Schema.Struct({ argv: Schema.NonEmptyArray(Schema.String), ...nativeLaunchFields }),
]).annotate({ identifier: 'Bakeoff.NativeLaunch' })
export type NativeLaunch = typeof NativeLaunchSchema.Encoded
export type NativeExec = Omit<Exec, 'launch'> & NativeLaunch & UnsupportedPolicy
export const NativeTimingSchema = Schema.Union([
  Schema.Struct({ at: EveryScheduleSchema.fields.anchor }),
  Schema.Struct({ every: EveryScheduleSchema.fields.every, anchor: EveryScheduleSchema.fields.anchor, catchUp: Schema.optionalKey(CatchUpSchema) }),
  Schema.Struct({ calendar: Schema.Struct({ at: CalendarTimeSchema, timezone: IanaTimezoneSchema, days: Schema.optionalKey(CalendarDaysSchema) }), catchUp: Schema.optionalKey(CatchUpSchema) }),
]).annotate({ identifier: 'Bakeoff.NativeTiming' })
export type NativeTiming = typeof NativeTimingSchema.Encoded
export type NativeSchedule = Omit<Schedule, 'timing'> & NativeTiming & UnsupportedPolicy
const fromNativeLaunch = (input: NativeLaunch): Launch => {
  validate(NativeLaunchSchema, input)
  const options: LaunchOptions = {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.unset === undefined ? {} : { unset: input.unset }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  }
  return 'command' in input ? launch.shell(input.command, options) : launch.argv(input.argv, options)
}
const fromNativeTiming = (input: NativeTiming): Timing => {
  validate(NativeTimingSchema, input)
  return 'at' in input ? timing.at(input.at) : 'every' in input
    ? timing.every(input.every, input.anchor, input.catchUp)
    : timing.calendar({ ...input.calendar, ...(input.catchUp === undefined ? {} : { catchUp: input.catchUp }) })
}
export class MissionBuilder {
  readonly native: NativeMission
  readonly options: MissionOptions
  constructor(native: NativeMission, options: MissionOptions = {}) {
    this.native = native
    this.options = options
  }
  withSteps(...steps: readonly StepFragment[]): MissionBuilder { return new MissionBuilder(this.native, { ...this.options, steps }) }
  withFinally(...steps: readonly StepFragment[]): MissionBuilder { return new MissionBuilder(this.native, { ...this.options, finally: steps }) }
  withSchedule(schedule: Schedule): MissionBuilder { return new MissionBuilder(this.native, { ...this.options, schedule }) }
  build(): Mission { return makeMission({ native: this.native, ...this.options }) }
}
/** B: native-shaped typed builders. Both designs converge before lowering. */
export const DesignB = {
  review,
  launch: (input: NativeLaunch): Launch => fromNativeLaunch(input),
  timing: (input: NativeTiming): Timing => fromNativeTiming(input),
  exec: (input: NativeExec): Exec => {
    const { id, host, workspace, restart, policy, hardTimeout, consent, ...command } = input
    rejectUnsupported({ policy, consent, ...(hardTimeout === undefined ? {} : { hardTimeout }) })
    return DesignA.exec({ id, host, workspace, restart, launch: fromNativeLaunch(command) })
  },
  schedule: (input: NativeSchedule): Schedule => {
    const { id, host, work, policy, hardTimeout, consent, ...nativeTiming } = input
    rejectUnsupported({ policy, consent, ...(hardTimeout === undefined ? {} : { hardTimeout }) })
    return DesignA.schedule({ id, host, work, timing: fromNativeTiming(nativeTiming) })
  },
  step: (native: NativeStep, options: Omit<StepFragment, 'native'> = {}): StepFragment => makeStep({ native, ...options }),
  mission: (native: NativeMission, options: MissionOptions = {}): Mission => makeMission({ native, ...options }),
  from: (native: NativeMission): MissionBuilder => new MissionBuilder(native),
}
