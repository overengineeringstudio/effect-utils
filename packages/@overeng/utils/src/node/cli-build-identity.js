// Checked JavaScript: Node loads Vite config dependencies from node_modules without TS stripping.
import { formatRelativeTime } from '../build-identity.js'

// Declarations own the public types; checkJs checks each implementation against its signature.
/** @typedef {import('./cli-build-identity.d.ts').LocalStamp} LocalStamp */
/** @typedef {import('./cli-build-identity.d.ts').NixStamp} NixStamp */
/** @typedef {import('./cli-build-identity.d.ts').ReleaseStamp} ReleaseStamp */
/** @typedef {import('./cli-build-identity.d.ts').CliStamp} CliStamp */
/** @typedef {import('./cli-build-identity.d.ts').CliBuildIdentity} CliBuildIdentity */
/** @typedef {import('./cli-build-identity.d.ts').ResolveBuildIdentityOptions} ResolveBuildIdentityOptions */

/**
 * Parse the canonical local/Nix/release JSON stamp.
 * @type {typeof import('./cli-build-identity.d.ts').parseCliBuildStamp}
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
    } else if (parsed.type === 'nix' || parsed.type === 'release') {
      if (
        typeof parsed.version === 'string' &&
        typeof parsed.rev === 'string' &&
        typeof parsed.commitTs === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        const buildTs = typeof parsed.buildTs === 'number' ? parsed.buildTs : undefined
        return {
          type: parsed.type,
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

const dirtyNote = (/** @type {boolean} */ dirty) =>
  dirty === true ? ', with uncommitted changes' : ''

/** @param {{baseVersion: string, stamp: LocalStamp, now: number | null}} options */
const renderLocalVersion = ({ baseVersion, stamp, now }) => {
  if (now === null) {
    return `${baseVersion} — running from local source (${stamp.rev}${dirtyNote(stamp.dirty)})`
  }
  const timeAgo =
    stamp.commitTs === undefined
      ? formatRelativeTime({ ts: stamp.ts, now, format: 'long' })
      : `committed ${formatRelativeTime({ ts: stamp.commitTs, now, format: 'long' })}`
  return `${baseVersion} — running from local source (${stamp.rev}, ${timeAgo}${dirtyNote(stamp.dirty)})`
}

/**
 * Nix stamps carry a short revision; release stamps keep the full revision for provenance.
 * @param {NixStamp | ReleaseStamp} stamp
 */
const committedMachineVersion = (stamp) => {
  const rev = stamp.type === 'release' ? stamp.rev.slice(0, 7) : stamp.rev
  const revAlreadyHasDirty = rev.endsWith('-dirty')
  const dirtySuffix = stamp.dirty === true && revAlreadyHasDirty === false ? '-dirty' : ''
  return `${stamp.version}+${rev}${dirtySuffix}`
}

/** @param {{baseVersion: string, stamp: LocalStamp}} options */
const localMachineVersion = ({ baseVersion, stamp }) =>
  `${baseVersion}+local.${stamp.rev}${stamp.dirty === true ? '.dirty' : ''}`

/**
 * Nix prose keeps its build age. A release build describes its revision's age;
 * deployment age belongs to the separate `deployed` detail derived from buildTs.
 * Without a clock (`now: null`), committed metadata is the timeless machine version.
 * @param {{stamp: NixStamp | ReleaseStamp, now: number | null}} options
 */
const renderCommittedVersion = ({ stamp, now }) => {
  const versionStr = committedMachineVersion(stamp)
  if (now === null) return versionStr
  if (stamp.type === 'nix' && stamp.buildTs !== undefined) {
    return `${versionStr} — built ${formatRelativeTime({ ts: stamp.buildTs, now, format: 'long' })}${dirtyNote(stamp.dirty)}`
  }
  return `${versionStr} — committed ${formatRelativeTime({ ts: stamp.commitTs, now, format: 'long' })}${dirtyNote(stamp.dirty)}`
}

/** @param {{stamp: NixStamp | ReleaseStamp, now: number | null}} options @returns {CliBuildIdentity} */
const committedBuildIdentity = ({ stamp, now }) => ({
  baseVersion: stamp.version,
  displayVersion: renderCommittedVersion({ stamp, now }),
  machineVersion: committedMachineVersion(stamp),
  sourceKind: stamp.type,
  rev: stamp.rev,
  dirty: stamp.dirty,
  commitTs: stamp.commitTs,
  ...(stamp.buildTs === undefined ? {} : { buildTs: stamp.buildTs }),
})

/**
 * Resolve the canonical identity. Embedded Nix/release metadata takes precedence over runtime stamps.
 * @type {typeof import('./cli-build-identity.d.ts').resolveCliBuildIdentity}
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
  if (buildTimeStamp?.type === 'nix' || buildTimeStamp?.type === 'release')
    return committedBuildIdentity({ stamp: buildTimeStamp, now })
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
  if (runtimeStamp?.type === 'nix' || runtimeStamp?.type === 'release')
    return committedBuildIdentity({ stamp: runtimeStamp, now })
  return {
    baseVersion,
    displayVersion: baseVersion,
    machineVersion: baseVersion,
    sourceKind: 'package',
    dirty: false,
  }
}

/** @type {typeof import('./cli-build-identity.d.ts').resolveCliMachineVersion} */
export const resolveCliMachineVersion = (options) => resolveCliBuildIdentity(options).machineVersion

/** @type {typeof import('./cli-build-identity.d.ts').resolveCliVersion} */
export const resolveCliVersion = (options) => resolveCliBuildIdentity(options).displayVersion
