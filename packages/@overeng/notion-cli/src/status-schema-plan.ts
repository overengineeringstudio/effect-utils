import type { SelectOptionConfig, StatusPropertySchema } from '@overeng/notion-effect-schema'

/** Drift kinds the native Notion status schema planner can classify. */
export type StatusSchemaDriftKind =
  | 'color_changed'
  | 'extra_remote_option'
  | 'group_changed'
  | 'rename_or_identity_mismatch'

/** A single status schema drift finding between desired code-owned schema and live Notion schema. */
export interface StatusSchemaDrift {
  readonly kind: StatusSchemaDriftKind
  readonly message: string
  readonly desired?: SelectOptionConfig
  readonly live?: SelectOptionConfig
}

/** Status schema convergence plan with additive mutation candidates and drift diagnostics. */
export interface StatusSchemaPlan {
  readonly propertyName: string
  readonly missingOptions: readonly SelectOptionConfig[]
  readonly unsupportedDrift: readonly StatusSchemaDrift[]
  /** Whether additive option mutation can proceed without mutation-blocking drift. */
  readonly canApplySafely: boolean
  readonly applyOptions: readonly SelectOptionConfig[]
}

/** Inputs for planning native Notion status schema convergence. */
export interface PlanStatusSchemaOptions {
  readonly desired: StatusPropertySchema
  readonly live: StatusPropertySchema
}

const sameOptionIds = ({
  left,
  right,
}: {
  readonly left: readonly string[]
  readonly right: readonly string[]
}): boolean => left.length === right.length && left.every((value, index) => value === right[index])

const sameGroups = ({
  desired,
  live,
}: {
  readonly desired: StatusPropertySchema
  readonly live: StatusPropertySchema
}): boolean => {
  if (desired.status.groups.length !== live.status.groups.length) {
    return false
  }

  return desired.status.groups.every((desiredGroup, index) => {
    const liveGroup = live.status.groups[index]
    return (
      liveGroup !== undefined &&
      desiredGroup.id === liveGroup.id &&
      desiredGroup.name === liveGroup.name &&
      desiredGroup.color === liveGroup.color &&
      sameOptionIds({ left: desiredGroup.option_ids, right: liveGroup.option_ids })
    )
  })
}

/** Returns whether a drift kind blocks additive option mutation. */
export const isStatusSchemaMutationBlockingDrift = (drift: StatusSchemaDrift): boolean =>
  drift.kind !== 'group_changed'

/** Plans additive native Notion status option convergence while reporting unapplyable drift. */
export const planStatusSchema = ({ desired, live }: PlanStatusSchemaOptions): StatusSchemaPlan => {
  const liveById = new Map(live.status.options.map((option) => [option.id, option]))
  const liveByName = new Map(live.status.options.map((option) => [option.name, option]))
  const desiredById = new Map(desired.status.options.map((option) => [option.id, option]))
  const desiredByName = new Map(desired.status.options.map((option) => [option.name, option]))

  const missingOptions: SelectOptionConfig[] = []
  const unsupportedDrift: StatusSchemaDrift[] = []

  for (const desiredOption of desired.status.options) {
    const liveBySameId = liveById.get(desiredOption.id)
    if (liveBySameId !== undefined) {
      if (liveBySameId.name !== desiredOption.name) {
        unsupportedDrift.push({
          kind: 'rename_or_identity_mismatch',
          message: `Status option id ${desiredOption.id} is named "${liveBySameId.name}" remotely but "${desiredOption.name}" in desired schema.`,
          desired: desiredOption,
          live: liveBySameId,
        })
      }
      if (liveBySameId.color !== desiredOption.color) {
        unsupportedDrift.push({
          kind: 'color_changed',
          message: `Status option "${desiredOption.name}" has color "${liveBySameId.color}" remotely but "${desiredOption.color}" in desired schema.`,
          desired: desiredOption,
          live: liveBySameId,
        })
      }
      continue
    }

    const liveBySameName = liveByName.get(desiredOption.name)
    if (liveBySameName !== undefined) {
      unsupportedDrift.push({
        kind: 'rename_or_identity_mismatch',
        message: `Status option "${desiredOption.name}" exists remotely with id ${liveBySameName.id} but desired schema uses id ${desiredOption.id}.`,
        desired: desiredOption,
        live: liveBySameName,
      })
      continue
    }

    missingOptions.push(desiredOption)
  }

  for (const liveOption of live.status.options) {
    const desiredBySameId = desiredById.get(liveOption.id)
    if (desiredBySameId !== undefined) {
      continue
    }

    const desiredBySameName = desiredByName.get(liveOption.name)
    if (desiredBySameName !== undefined) {
      continue
    }

    unsupportedDrift.push({
      kind: 'extra_remote_option',
      message: `Status option "${liveOption.name}" exists remotely but not in desired schema; removal is not safely applyable.`,
      live: liveOption,
    })
  }

  if (sameGroups({ desired, live }) === false) {
    unsupportedDrift.push({
      kind: 'group_changed',
      message:
        'Status groups differ between desired and live schema; group convergence is report-only until the Notion API proves safe apply support.',
    })
  }

  return {
    propertyName: desired.name,
    missingOptions,
    unsupportedDrift,
    canApplySafely: unsupportedDrift.every((drift) => !isStatusSchemaMutationBlockingDrift(drift)),
    applyOptions: [...live.status.options, ...missingOptions],
  }
}
