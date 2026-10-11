// Checked JavaScript: Node loads Vite config dependencies from node_modules without TS stripping.
import { formatRelativeTime } from '../build-identity.js'

/** @typedef {{readonly type: 'local', readonly rev: string, readonly ts: number, readonly commitTs?: number, readonly dirty: boolean}} LocalStamp */
/** @typedef {{readonly type: 'nix', readonly version: string, readonly rev: string, readonly commitTs: number, readonly buildTs?: number, readonly dirty: boolean}} NixStamp */
/** @typedef {LocalStamp | NixStamp} CliStamp */
/**
 * Structured build identity shared by CLIs, UIs, diagnostics, and telemetry.
 * @typedef {{readonly baseVersion: string, readonly displayVersion: string, readonly machineVersion: string, readonly sourceKind: 'package' | 'local' | 'nix', readonly rev?: string, readonly dirty: boolean, readonly commitTs?: number, readonly buildTs?: number}} CliBuildIdentity
 */
/** @typedef {{readonly baseVersion: string, readonly buildStamp: string, readonly env?: Readonly<Record<string, string | undefined>>, readonly now?: number, readonly runtimeStampEnvVar?: string}} ResolveBuildIdentityOptions */

/**
 * Parse the canonical local/Nix JSON stamp.
 * @param {string} stamp
 * @returns {CliStamp | undefined}
 */
export const parseCliBuildStamp = (stamp) => {
  try {
    const parsed = JSON.parse(stamp)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    if (parsed.type === 'local') {
      if (
        typeof parsed.rev === 'string' &&
        typeof parsed.ts === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        const commitTs = typeof parsed.commitTs === 'number' ? parsed.commitTs : undefined
        return {
          type: 'local',
          rev: parsed.rev,
          ts: parsed.ts,
          ...(commitTs === undefined ? {} : { commitTs }),
          dirty: parsed.dirty,
        }
      }
    } else if (parsed.type === 'nix') {
      if (
        typeof parsed.version === 'string' &&
        typeof parsed.rev === 'string' &&
        typeof parsed.commitTs === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        const buildTs = typeof parsed.buildTs === 'number' ? parsed.buildTs : undefined
        return {
          type: 'nix',
          version: parsed.version,
          rev: parsed.rev,
          commitTs: parsed.commitTs,
          ...(buildTs === undefined ? {} : { buildTs }),
          dirty: parsed.dirty,
        }
      }
    }
  } catch {
    // Invalid JSON.
  }
  return undefined
}

/** @param {{baseVersion: string, stamp: LocalStamp, now: number}} options */
const renderLocalVersion = ({ baseVersion, stamp, now }) => {
  const timeAgo =
    stamp.commitTs === undefined
      ? formatRelativeTime({ ts: stamp.ts, now, format: 'long' })
      : `committed ${formatRelativeTime({ ts: stamp.commitTs, now, format: 'long' })}`
  const dirtyNote = stamp.dirty === true ? ', with uncommitted changes' : ''
  return `${baseVersion} — running from local source (${stamp.rev}, ${timeAgo}${dirtyNote})`
}

/** @param {NixStamp} stamp */
const nixMachineVersion = (stamp) => {
  const revAlreadyHasDirty = stamp.rev.endsWith('-dirty')
  const dirtySuffix = stamp.dirty === true && revAlreadyHasDirty === false ? '-dirty' : ''
  return `${stamp.version}+${stamp.rev}${dirtySuffix}`
}

/** @param {{baseVersion: string, stamp: LocalStamp}} options */
const localMachineVersion = ({ baseVersion, stamp }) =>
  `${baseVersion}+local.${stamp.rev}${stamp.dirty === true ? '.dirty' : ''}`

/** @param {{stamp: NixStamp, now: number}} options */
const renderNixVersion = ({ stamp, now }) => {
  const versionStr = nixMachineVersion(stamp)
  const dirtyNote = stamp.dirty === true ? ', with uncommitted changes' : ''
  if (stamp.buildTs !== undefined) {
    return `${versionStr} — built ${formatRelativeTime({ ts: stamp.buildTs, now, format: 'long' })}${dirtyNote}`
  }
  return `${versionStr} — committed ${formatRelativeTime({ ts: stamp.commitTs, now, format: 'long' })}${dirtyNote}`
}

/** @param {{stamp: NixStamp, now: number}} options @returns {CliBuildIdentity} */
const nixBuildIdentity = ({ stamp, now }) => ({
  baseVersion: stamp.version,
  displayVersion: renderNixVersion({ stamp, now }),
  machineVersion: nixMachineVersion(stamp),
  sourceKind: 'nix',
  rev: stamp.rev,
  dirty: stamp.dirty,
  commitTs: stamp.commitTs,
  ...(stamp.buildTs === undefined ? {} : { buildTs: stamp.buildTs }),
})

/**
 * Resolve the canonical identity. Embedded Nix metadata takes precedence over runtime stamps.
 * @param {ResolveBuildIdentityOptions} options
 * @returns {CliBuildIdentity}
 */
export const resolveCliBuildIdentity = (options) => {
  const {
    baseVersion,
    buildStamp,
    env = process.env,
    now = Math.floor(Date.now() / 1000),
    runtimeStampEnvVar = 'CLI_BUILD_STAMP',
  } = options
  const buildTimeStamp = parseCliBuildStamp(buildStamp)
  if (buildTimeStamp?.type === 'nix') return nixBuildIdentity({ stamp: buildTimeStamp, now })
  const runtimeStampRaw = env[runtimeStampEnvVar]?.trim()
  const runtimeStamp =
    runtimeStampRaw === undefined || runtimeStampRaw.length === 0
      ? undefined
      : parseCliBuildStamp(runtimeStampRaw)
  if (runtimeStamp?.type === 'local') {
    return {
      baseVersion,
      displayVersion: renderLocalVersion({ baseVersion, stamp: runtimeStamp, now }),
      machineVersion: localMachineVersion({ baseVersion, stamp: runtimeStamp }),
      sourceKind: 'local',
      rev: runtimeStamp.rev,
      dirty: runtimeStamp.dirty,
      buildTs: runtimeStamp.ts,
      ...(runtimeStamp.commitTs === undefined ? {} : { commitTs: runtimeStamp.commitTs }),
    }
  }
  if (runtimeStamp?.type === 'nix') return nixBuildIdentity({ stamp: runtimeStamp, now })
  return {
    baseVersion,
    displayVersion: baseVersion,
    machineVersion: baseVersion,
    sourceKind: 'package',
    dirty: false,
  }
}

/** @param {ResolveBuildIdentityOptions} options @returns {string} */
export const resolveCliMachineVersion = (options) => resolveCliBuildIdentity(options).machineVersion

/** @param {{baseVersion: string, buildStamp: string, runtimeStampEnvVar?: string}} options @returns {string} */
export const resolveCliVersion = (options) => resolveCliBuildIdentity(options).displayVersion
