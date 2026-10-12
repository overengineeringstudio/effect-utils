import { AgentTraceV2, leafPaths } from './schema.ts'
/** A machine key or an explicit reason why a semantic leaf is omitted. */
export type BindingEntry = { readonly key: string } | { readonly omit: string }
// Tagged unions are one atomic binding fact, matching leafPaths' union boundary.
type Leaves<T, TPrefix extends string = ''> = T extends string | { readonly _tag: string }
  ? TPrefix
  : {
      [K in keyof T & string]-?: Leaves<
        NonNullable<T[K]>,
        TPrefix extends '' ? K : `${TPrefix}.${K}`
      >
    }[keyof T & string]
/** Every semantic leaf path, derived from the authority type. */
export type LeafPath = Leaves<AgentTraceV2>
/** Frozen medium version and its complete semantic-leaf mapping. */
export type Binding = {
  readonly version: 'trailer/v2' | 'footer/v4'
  readonly paths: Readonly<Record<string, BindingEntry>>
}
const envelopeOmission = {
  omit: 'Event envelope belongs to the artifact record, not its attribution view',
} as const
/** Footer binding preserving attribution facts and omitting the event envelope. */
export const footerV4 = {
  version: 'footer/v4',
  paths: {
    type: { key: 'type' },
    id: envelopeOmission,
    at: envelopeOmission,
    artifact: envelopeOmission,
    'who.agent': { key: 'who.agent' },
    'who.principal': { key: 'who.principal' },
    'who.actor': { key: 'who.actor' },
    'who.persona': { key: 'who.persona' },
    'who.supervisor': { key: 'who.supervisor' },
    'why.mission.name': { key: 'why.mission.name' },
    'why.mission.run': { key: 'why.mission.run' },
    'why.step.name': { key: 'why.step.name' },
    'why.step.run': { key: 'why.step.run' },
    'how.harness.tool': { key: 'how.harness.tool' },
    'how.harness.version': { key: 'how.harness.version' },
    'how.model.route': { key: 'how.model.route' },
    'how.model.effort': { key: 'how.model.effort' },
    'how.tooling_profile': { key: 'how.tooling_profile' },
    'how.runtime_profile': { key: 'how.runtime_profile' },
    'how.skills_manifest': { key: 'how.skills_manifest' },
    'how.invocation_id': { key: 'how.invocation_id' },
    'how.issuance': { key: 'how.issuance' },
    'where.session': { key: 'where.session' },
    'where.host': { key: 'where.host' },
    'where.worktree': { key: 'where.worktree' },
  },
} as const satisfies Binding & { readonly paths: Readonly<Record<LeafPath, BindingEntry>> }
const navigationOmission = {
  omit: 'Commit attribution does not carry session navigation or execution topology',
} as const
/** Commit binding omitting session navigation and execution topology. */
export const trailerV2 = {
  version: 'trailer/v2',
  paths: {
    ...footerV4.paths,
    'where.session': navigationOmission,
    'where.host': navigationOmission,
    'where.worktree': navigationOmission,
  },
} as const satisfies Binding & { readonly paths: Readonly<Record<LeafPath, BindingEntry>> }
/** Rejects missing leaves, unexpected leaves, duplicate keys and unexplained omissions. */
export const validateBinding = (binding: {
  readonly paths: Readonly<Record<string, BindingEntry>>
}): void => {
  const paths = leafPaths({ ast: AgentTraceV2.ast })
  const missing = paths.filter((path) => !Object.hasOwn(binding.paths, path))
  const extra = Object.keys(binding.paths).filter((path) => !paths.includes(path))
  const keys = Object.values(binding.paths).flatMap((entry) => ('key' in entry ? [entry.key] : []))
  if (
    missing.length ||
    extra.length ||
    keys.length !== new Set(keys).size ||
    Object.values(binding.paths).some((entry) => 'omit' in entry && !entry.omit.trim())
  )
    throw new TypeError(
      'Binding must map every leaf exactly once to a unique key or a reasoned omission',
    )
}
