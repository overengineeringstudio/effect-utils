import { matchesGlob } from 'node:path'

import { buckDurationMs, type StoreBuckMaintainConfig } from './store-buck-maintain-config.ts'

/** Stable safety-gate reasons included in maintenance receipts. */
export type MaintainSkipReason =
  | 'blackout'
  | 'git-locked'
  | 'holder-live'
  | 'holder-census-incomplete'
  | 'seat-claims-incomplete'
  | 'active-claim'
  | 'foreign-owner'
  | 'unknown-owner'
  | 'lease-held'

/** Native output-maintenance action selected by the configured policy. */
export type BuckOutDecision = 'within-budget' | 'clean-stale' | 'full-clean'

/** Work inactivity is bounded by Git/Buck activity, not by how long a daemon has been absent. */
export const fullCleanLastActivityMs = ({
  gitActivityMs,
  buckActivityMs,
}: {
  gitActivityMs: number | undefined
  buckActivityMs: number | undefined
}): number | undefined =>
  gitActivityMs === undefined ||
  buckActivityMs === undefined ||
  Number.isFinite(gitActivityMs) === false ||
  Number.isFinite(buckActivityMs) === false
    ? undefined
    : Math.max(gitActivityMs, buckActivityMs)

/** Full cleanup is independently opt-in; stale trimming requires a strictly exceeded budget. */
export const decideBuckOut = ({
  sizeBytes,
  lastActivityMs,
  now,
  policy,
  inactive,
}: {
  readonly sizeBytes: number
  readonly lastActivityMs: number | undefined
  readonly now: number
  readonly policy: StoreBuckMaintainConfig['buckOut']
  readonly inactive: boolean
}): BuckOutDecision => {
  if (
    inactive === true &&
    policy.fullCleanWhenInactiveFor !== undefined &&
    lastActivityMs !== undefined &&
    Number.isFinite(lastActivityMs) === true &&
    lastActivityMs <= now &&
    now - lastActivityMs >= buckDurationMs(policy.fullCleanWhenInactiveFor)
  )
    return 'full-clean'
  return sizeBytes > policy.budgetBytes ? 'clean-stale' : 'within-budget'
}

/** Empty commands alone are insufficient: the caller must also prove no attached clients. */
export const isDaemonIdle = ({
  activeCommands,
  attachedClients,
  lastActivityMs,
  now,
  idleStopAfterMs,
}: {
  readonly activeCommands: readonly unknown[] | undefined
  readonly attachedClients: number | undefined
  readonly lastActivityMs: number | undefined
  readonly now: number
  readonly idleStopAfterMs: number
}): boolean =>
  activeCommands !== undefined &&
  activeCommands.length === 0 &&
  attachedClients === 0 &&
  lastActivityMs !== undefined &&
  Number.isFinite(lastActivityMs) === true &&
  lastActivityMs <= now &&
  Number.isFinite(idleStopAfterMs) === true &&
  idleStopAfterMs >= 0 &&
  now - lastActivityMs >= idleStopAfterMs

const utcMinute = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

/** UTC windows are start-inclusive/end-exclusive; equal endpoints cover the full day. */
export const isInBlackout = ({
  now,
  blackout,
}: {
  readonly now: number
  readonly blackout: StoreBuckMaintainConfig['blackout']
}): boolean => {
  const date = new Date(now)
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return blackout.some(({ startUtc, endUtc }) => {
    const start = utcMinute(startUtc)
    const end = utcMinute(endUtc)
    return (
      start === end ||
      (start < end ? minute >= start && minute < end : minute >= start || minute < end)
    )
  })
}

/** Anchored exact identifiers and standard path globs; no special all-owner enum. */
export const matchesMaintainOwner = ({
  owner,
  pattern,
}: {
  owner: string
  pattern: string
}): boolean => owner === pattern || matchesGlob(owner, pattern)

/** Every observed owner must be admitted; missing evidence never defaults to the current seat. */
export const decideMaintainGate = ({
  blackout,
  gitLocked,
  liveHolder,
  activeClaim,
  seatClaimsComplete,
  owners,
  currentAgent,
  maintainOwners,
  maintainUnowned,
  leaseHeld,
}: {
  readonly blackout: boolean
  readonly gitLocked: boolean | undefined
  readonly liveHolder: boolean | undefined
  readonly activeClaim: boolean | undefined
  readonly seatClaimsComplete: boolean
  readonly owners: readonly (string | null)[] | undefined
  readonly currentAgent?: string | undefined
  readonly maintainOwners: readonly string[]
  readonly maintainUnowned: boolean
  readonly leaseHeld: boolean | undefined
}): MaintainSkipReason | undefined => {
  if (blackout === true) return 'blackout'
  if (gitLocked !== false) return 'git-locked'
  if (liveHolder === true) return 'holder-live'
  if (liveHolder !== false) return 'holder-census-incomplete'
  if (seatClaimsComplete !== true) return 'seat-claims-incomplete'
  if (activeClaim !== false) return 'active-claim'
  if (owners === undefined) return 'foreign-owner'
  if (owners.length === 0) {
    if (maintainUnowned === false) return 'unknown-owner'
  } else if (
    owners.every(
      (owner) =>
        owner !== null &&
        owner.length > 0 &&
        (maintainOwners.length > 0
          ? maintainOwners.some((pattern) => matchesMaintainOwner({ owner, pattern }))
          : owner === currentAgent),
    ) === false
  ) {
    return 'foreign-owner'
  }
  if (leaseHeld !== false) return 'lease-held'
  return undefined
}
