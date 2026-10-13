import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Effect, FileSystem, Schema } from 'effect'

import { parse } from '@overeng/kdl'

import {
  AgentSchema,
  MissionSchema,
  missionWire,
  type MissionInput,
  SubjectId,
  type ScheduleSchema,
  type WorkSchema,
} from './mod.ts'

/** The declaration file kind; a `schedule` is a mission that carries a schedule. */
export type SubjectKind = 'agent' | 'mission' | 'schedule'

/** A subject tree that cannot be loaded; `path` is relative to the tree root where known. */
export class SubjectTreeError extends Schema.TaggedError<SubjectTreeError>()('SubjectTreeError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A typed pointer to a subject module; the tree loader derives its ID from the module path. */
export interface SubjectRef<K extends SubjectKind> {
  readonly _tag: 'SubjectRef'
  readonly kind: K
  /** The defining module's `import.meta.url`. */
  readonly url: string
}

/** A seat reference; lowers to `agent/<id>` as a step assignee. */
export type AgentRef = SubjectRef<'agent'>

/** A mission reference; lowers to the unpinned mission ID `<id>` as schedule work. */
export type MissionRef = SubjectRef<'mission'>

/** A subject module's default export: a reference plus its intent or a context factory. */
export interface SubjectDefinition<K extends SubjectKind, I, C> extends SubjectRef<K> {
  readonly intent: I | ((context: C) => I)
}

type WorkWire = typeof WorkSchema.Encoded

/** Agent fields without `id`; supervisor targets may be typed seat references. */
export type AgentIntent = Omit<typeof AgentSchema.Encoded, 'id' | 'under'> & {
  readonly under?: ReadonlyArray<{
    readonly target: AgentRef | NonNullable<(typeof AgentSchema.Encoded)['under']>[number]['target']
    readonly reason?: string
  }>
}

type TreeStep<T> = T extends { readonly round: infer R }
  ? Omit<T, 'round'> & { readonly round: TreeRound<R> }
  : { [K in keyof T]: K extends 'assignedTo' ? T[K] | AgentRef : T[K] }

type TreeSteps<T> = T extends readonly unknown[] ? { [K in keyof T]: TreeStep<T[K]> } : T

type TreeRound<T> = {
  [K in keyof T]: K extends 'steps' | 'finally' ? TreeSteps<T[K]> : T[K]
}

/** Path-derived mission ID with current authoring handles and typed seat references. */
export type MissionIntent = Omit<
  MissionInput<string>,
  'id' | 'steps' | 'finally' | 'schedule' | 'reportTo' | 'assignedTo'
> & {
  readonly reportTo: AgentRef | MissionInput<string>['reportTo']
  readonly assignedTo?: AgentRef | MissionInput<string>['assignedTo']
  readonly steps: ReadonlyArray<TreeStep<MissionInput<string>['steps'][number]>>
  readonly finally?: ReadonlyArray<TreeStep<NonNullable<MissionInput<string>['finally']>[number]>>
}

// Replace work separately for each interval/calendar variant, retaining its required fields.
type TreeSchedule<TSchedule> = TSchedule extends unknown
  ? Omit<TSchedule, 'work'> & {
      readonly work: Omit<WorkWire, 'mission'> & {
        readonly mission: MissionRef | WorkWire['mission']
      }
    }
  : never

/** Mission fields for a schedule file; its work may name a typed mission reference. */
export type ScheduleIntent = MissionIntent & {
  readonly schedule: TreeSchedule<typeof ScheduleSchema.Encoded>
}

/** `meta` is the defining module's `import.meta`; `intent` is a value or a context factory. */
type DefineArgs<I, C> = {
  readonly meta: { readonly url: string }
  readonly intent: I | ((context: C) => I)
}

type Define<K extends SubjectKind, I> = <C = never>(
  args: DefineArgs<I, C>,
) => SubjectDefinition<K, I, C>

const define =
  <K extends SubjectKind>(kind: K) =>
  <I, C>({ meta, intent }: DefineArgs<I, C>): SubjectDefinition<K, I, C> => ({
    _tag: 'SubjectRef',
    kind,
    url: meta.url,
    intent,
  })

/** Defines the seat declared by an `agent.ts` module. */
export const defineAgent: Define<'agent', AgentIntent> = define('agent')

/** Defines the mission declared by a `mission.ts` module. */
export const defineMission: Define<'mission', MissionIntent> = define('mission')

/** Defines the scheduled mission declared by a `schedule.ts` module. */
export const defineSchedule: Define<'schedule', ScheduleIntent> = define('schedule')

type Declaration<T> =
  | { readonly _tag: 'Kdl'; readonly text: string }
  | {
      readonly _tag: 'Module'
      readonly intent: T
      readonly exports: Readonly<Record<string, unknown>>
    }

/** A loaded declaration; `path` is POSIX and relative to the tree root. */
export type Subject =
  | {
      readonly kind: 'agent'
      readonly id: SubjectId
      readonly path: string
      readonly declaration: Declaration<typeof AgentSchema.Type>
    }
  | {
      readonly kind: 'mission' | 'schedule'
      readonly id: SubjectId
      readonly path: string
      readonly declaration: Declaration<typeof MissionSchema.Type>
    }

const declarationFile = /^(agent|mission|schedule)\.(ts|kdl)$/u

const scheduleMismatch: Record<Exclude<SubjectKind, 'agent'>, string> = {
  mission: 'A mission with a schedule must be declared in schedule.ts or schedule.kdl',
  schedule: 'A schedule file must declare a mission with a schedule',
}

const isRef = (value: unknown): value is SubjectRef<SubjectKind> =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'SubjectRef'

/** A declaration's subject ID is its directory relative to the tree root, POSIX-separated. */
const subjectId = ({
  root,
  file,
  path,
}: {
  readonly root: string
  readonly file: string
  readonly path: string
}) =>
  Schema.decodeEffect(SubjectId)(relative(root, dirname(file)).split(sep).join('/')).pipe(
    Effect.mapError(
      (cause) =>
        new SubjectTreeError({
          path,
          message: 'Subject directory is not a valid subject ID inside the tree',
          cause,
        }),
    ),
  )

const resolveRef = Effect.fnUntraced(function* ({
  root,
  path,
  ref,
  expected,
}: {
  readonly root: string
  readonly path: string
  readonly ref: SubjectRef<SubjectKind>
  readonly expected: 'agent' | 'mission'
}) {
  if (ref.kind !== expected) {
    return yield* new SubjectTreeError({
      path,
      message: `Reference must point at ${expected}.ts, got ${ref.kind}.ts`,
    })
  }
  const file = yield* Effect.try({
    try: () => fileURLToPath(ref.url),
    catch: (cause) =>
      new SubjectTreeError({ path, message: 'Reference has no module file URL', cause }),
  })
  if (basename(file) !== `${expected}.ts`) {
    return yield* new SubjectTreeError({
      path,
      message: `Reference must point at ${expected}.ts, got ${basename(file)}`,
    })
  }
  return yield* subjectId({ root, file, path })
})

type ReferenceFields = {
  readonly reportTo?: unknown
  readonly assignedTo?: unknown
  readonly target?: unknown
  readonly steps?: unknown
  readonly finally?: unknown
  readonly under?: unknown
}

/** Lowers only reference-bearing fields, preserving identity-bearing authoring handles. */
const lowerReferences: (args: {
  readonly root: string
  readonly path: string
  readonly intent: unknown
}) => Effect.Effect<unknown, SubjectTreeError> = Effect.fnUntraced(function* ({ root, path, intent }) {
  if (typeof intent !== 'object' || intent === null) return intent
  const fields = intent as ReferenceFields
  let lowered: Record<PropertyKey, unknown> | undefined
  const set = (key: string, value: unknown) => {
    lowered ??= { ...intent }
    lowered[key] = value
  }
  for (const key of ['reportTo', 'assignedTo', 'target'] as const) {
    if (key in intent && isRef(fields[key]) === true) {
      const id = yield* resolveRef({ root, path, ref: fields[key], expected: 'agent' })
      set(key, { id })
    }
  }
  for (const key of ['steps', 'finally', 'under'] as const) {
    if (key in intent && Array.isArray(fields[key]) === true) {
      const values = fields[key]
      const next = yield* Effect.forEach(values as readonly unknown[], (value) =>
        lowerReferences({ root, path, intent: value }),
      )
      if (next.some((value, index) => value !== values[index])) set(key, next)
    }
  }
  if ('round' in intent) {
    const round = yield* lowerReferences({ root, path, intent: intent.round })
    if (round !== intent.round) set('round', round)
  }
  if ('schedule' in intent && typeof intent.schedule === 'object' && intent.schedule !== null) {
    const schedule = intent.schedule
    if ('work' in schedule && typeof schedule.work === 'object' && schedule.work !== null) {
      const work = schedule.work
      if ('mission' in work && isRef(work.mission) === true) {
        const mission = yield* resolveRef({ root, path, ref: work.mission, expected: 'mission' })
        set('schedule', { ...schedule, work: { ...work, mission } })
      }
    }
  }
  return lowered ?? intent
})

const loadModule = Effect.fnUntraced(function* <C>({
  root,
  file,
  path,
  kind,
  id,
  context,
}: {
  readonly root: string
  /** The module's realpath, which is what Node reports as its `import.meta.url`. */
  readonly file: string
  readonly path: string
  readonly kind: SubjectKind
  readonly id: SubjectId
  readonly context: C
}) {
  const url = pathToFileURL(file).href
  const exports = yield* Effect.tryPromise({
    // oxlint-disable-next-line import/no-dynamic-require -- subject modules are trusted repository code discovered by path
    try: (): Promise<Readonly<Record<string, unknown>>> => import(url),
    catch: (cause) =>
      new SubjectTreeError({ path, message: 'Cannot import subject module', cause }),
  })
  if ('default' in exports === false) {
    return yield* new SubjectTreeError({ path, message: 'Subject module needs a default export' })
  }
  const value = exports.default
  const definition = isRef(value) === true ? value : undefined
  if (definition !== undefined && (definition.kind !== kind || definition.url !== url)) {
    return yield* new SubjectTreeError({
      path,
      message: `Module must export its own ${kind} definition, got ${definition.kind} from ${definition.url}`,
    })
  }
  const source =
    definition === undefined ? value : 'intent' in definition ? definition.intent : undefined
  const intent = yield* Effect.try({
    try: (): unknown => (typeof source === 'function' ? source(context) : source),
    catch: (cause) => new SubjectTreeError({ path, message: 'Subject factory failed', cause }),
  })
  // Definitions take their ID from the path; an explicit `id` in the intent must still agree.
  const identified =
    definition !== undefined && typeof intent === 'object' && intent !== null
      ? { id, ...intent }
      : intent
  if (
    typeof identified === 'object' &&
    identified !== null &&
    'id' in identified &&
    identified.id !== id
  ) {
    return yield* new SubjectTreeError({
      path,
      message: `Declared id ${String(identified.id)} must equal the subject directory ${id}`,
    })
  }
  const invalid = (cause: unknown) =>
    new SubjectTreeError({ path, message: `Invalid ${kind} declaration`, cause })
  const lowered = yield* lowerReferences({ root, path, intent: identified })
  if (kind === 'agent') {
    const agent = yield* Schema.decodeUnknownEffect(AgentSchema, { onExcessProperty: 'error' })(
      lowered,
    ).pipe(Effect.mapError(invalid))
    const subject: Subject = {
      kind,
      id,
      path,
      declaration: { _tag: 'Module', intent: agent, exports },
    }
    return subject
  }
  const wire = yield* Effect.try({
    // Trusted module authoring is validated by missionWire's strict schemas; the
    // boundary assertion preserves templates/handles until assembly, not a wire cast.
    try: () => missionWire(lowered as MissionInput<string>),
    catch: invalid,
  })
  const mission = yield* Schema.decodeEffect(MissionSchema, { onExcessProperty: 'error' })(
    wire,
  ).pipe(Effect.mapError(invalid))
  if ((mission.schedule !== undefined) !== (kind === 'schedule')) {
    return yield* new SubjectTreeError({ path, message: scheduleMismatch[kind] })
  }
  const subject: Subject = {
    kind,
    id,
    path,
    declaration: { _tag: 'Module', intent: mission, exports },
  }
  return subject
})

const loadKdl = Effect.fnUntraced(function* ({
  fs,
  file,
  path,
  kind,
  id,
}: {
  readonly fs: FileSystem.FileSystem
  readonly file: string
  readonly path: string
  readonly kind: SubjectKind
  readonly id: SubjectId
}) {
  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        (cause) => new SubjectTreeError({ path, message: 'Cannot read KDL declaration', cause }),
      ),
    )
  const nodes = yield* Effect.try({
    try: () => parse(text).nodes,
    catch: (cause) => new SubjectTreeError({ path, message: 'Invalid KDL declaration', cause }),
  })
  const name = kind === 'agent' ? 'agent' : 'mission'
  const [version, declaration] = nodes
  if (
    nodes.length !== 2 ||
    version?.getName() !== 'version' ||
    version.getArgument(0) !== 2 ||
    declaration?.getName() !== name ||
    declaration.getArgument(0) !== id
  ) {
    return yield* new SubjectTreeError({
      path,
      message: `KDL declaration must be \`version 2\` followed by exactly one \`${name} "${id}"\` node`,
    })
  }
  const scheduled = declaration.children?.findNodeByName('schedule') !== undefined
  if (kind !== 'agent' && scheduled !== (kind === 'schedule')) {
    return yield* new SubjectTreeError({ path, message: scheduleMismatch[kind] })
  }
  const subject: Subject = { kind, id, path, declaration: { _tag: 'Kdl', text } }
  return subject
})

/**
 * Loads `<root>/<id>/{agent,mission,schedule}.{ts,kdl}` declarations in path order.
 *
 * The ID is the POSIX directory path of the file's realpath below `root`'s realpath, so symlinked
 * aliases load once and links leaving the tree are rejected. Seats use the `agent/<id>` namespace; missions
 * and schedules share `mission/<id>`, so one directory declares at most one of them. KDL files must
 * hold `version 2` and one node whose kind and ID match the path. A TS module's default export is a
 * `define*` definition for its own path and kind, a plain intent, or a factory; factories receive
 * `context`. Typed references are lowered, then intents are decoded with `AgentSchema` or
 * `MissionSchema`. Subject modules are trusted code and are imported.
 */
export const loadSubjectTree = Effect.fn('genie-smalltalk.loadSubjectTree')(function* <C>({
  root,
  context,
}: {
  readonly root: string
  readonly context: C
}) {
  const fs = yield* FileSystem.FileSystem
  const tree = yield* fs.realPath(root).pipe(
    Effect.flatMap((real) =>
      fs
        .readDirectory(real, { recursive: true })
        .pipe(Effect.map((entries) => ({ real, entries }))),
    ),
    Effect.mapError(
      (cause) => new SubjectTreeError({ path: root, message: 'Cannot read subject tree', cause }),
    ),
  )
  const seen = new Set<string>()
  const loaded = new Set<string>()
  const subjects: Subject[] = []
  for (const entry of tree.entries.toSorted()) {
    const match = declarationFile.exec(basename(entry))
    if (match === null) continue
    const kind = match[1] as SubjectKind
    const discovered = entry.split(sep).join('/')
    // Directory symlinks are followed while listing; IDs and refs both use the canonical file.
    const file = yield* fs
      .realPath(join(tree.real, entry))
      .pipe(
        Effect.mapError(
          (cause) =>
            new SubjectTreeError({
              path: discovered,
              message: 'Cannot resolve declaration',
              cause,
            }),
        ),
      )
    if (loaded.has(file) === true) continue
    loaded.add(file)
    const id = yield* subjectId({ root: tree.real, file, path: discovered })
    const path = relative(tree.real, file).split(sep).join('/')
    const key = `${kind === 'agent' ? 'agent' : 'mission'}/${id}`
    if (seen.has(key) === true) {
      return yield* new SubjectTreeError({ path, message: `Duplicate subject ${key}` })
    }
    seen.add(key)
    subjects.push(
      match[2] === 'kdl'
        ? yield* loadKdl({ fs, file, path, kind, id })
        : yield* loadModule({ root: tree.real, file, path, kind, id, context }),
    )
  }
  return subjects.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})
