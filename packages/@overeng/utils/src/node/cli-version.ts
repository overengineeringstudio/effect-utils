/**
 * Local stamp: set via CLI_BUILD_STAMP env var when entering a dev shell.
 * Used for source-based CLI builds (running TypeScript directly).
 */
export interface LocalStamp {
  type: 'local'
  rev: string
  ts: number
  dirty: boolean
}

/**
 * Nix stamp: embedded in the binary at Nix build time.
 * Contains version info and commit timestamp for reproducible builds.
 */
export interface NixStamp {
  type: 'nix'
  version: string
  rev: string
  commitTs: number
  dirty: boolean
  buildTs?: number // only present for impure builds
}

export type CliStamp = LocalStamp | NixStamp

/**
 * Format a Unix timestamp as a human-readable relative time.
 * Uses medium formatting: "5 min ago", "2 hours ago", "3 days ago", "Jan 15"
 */
const formatRelativeTime = (ts: number): string => {
  const now = Math.floor(Date.now() / 1000)
  const diffSeconds = now - ts

  if (diffSeconds < 60) {
    return 'just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) {
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
  }

  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
  }

  // For older builds, show the date
  const date = new Date(ts * 1000)
  const month = date.toLocaleString('en-US', { month: 'short' })
  const day = date.getDate()
  return `${month} ${day}`
}

/**
 * Parse a JSON string as a CliStamp (LocalStamp or NixStamp).
 */
const parseStamp = (stamp: string): CliStamp | undefined => {
  try {
    const parsed = JSON.parse(stamp)
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }

    if (parsed.type === 'local') {
      if (
        typeof parsed.rev === 'string' &&
        typeof parsed.ts === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        return parsed as LocalStamp
      }
    } else if (parsed.type === 'nix') {
      if (
        typeof parsed.version === 'string' &&
        typeof parsed.rev === 'string' &&
        typeof parsed.commitTs === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        return parsed as NixStamp
      }
    }
  } catch {
    // Invalid JSON
  }
  return undefined
}

/**
 * Render version string for a LocalStamp.
 *
 * Output examples:
 * - dirty:  "0.1.0 — running from local source (abc123, 5 min ago, with uncommitted changes)"
 * - clean:  "0.1.0 — running from local source (abc123, 2 hours ago)"
 */
const renderLocalVersion = (baseVersion: string, stamp: LocalStamp): string => {
  const timeAgo = formatRelativeTime(stamp.ts)
  const dirtyNote = stamp.dirty ? ', with uncommitted changes' : ''
  return `${baseVersion} — running from local source (${stamp.rev}, ${timeAgo}${dirtyNote})`
}

/**
 * Render version string for a NixStamp.
 *
 * Output examples:
 * - pure, clean:   "0.1.0+def456 — committed 3 days ago"
 * - pure, dirty:   "0.1.0+def456-dirty — committed 3 days ago, with uncommitted changes"
 * - impure, clean: "0.1.0+def456 — built 2 hours ago"
 * - impure, dirty: "0.1.0+def456-dirty — built 2 hours ago, with uncommitted changes"
 */
const renderNixVersion = (stamp: NixStamp): string => {
  // Only add -dirty suffix if the rev doesn't already include it
  // (Nix flakes may provide dirtyShortRev which already has the suffix)
  const revAlreadyHasDirty = stamp.rev.endsWith('-dirty')
  const dirtySuffix = stamp.dirty && !revAlreadyHasDirty ? '-dirty' : ''
  const versionStr = `${stamp.version}+${stamp.rev}${dirtySuffix}`

  const dirtyNote = stamp.dirty ? ', with uncommitted changes' : ''

  if (stamp.buildTs !== undefined) {
    // Impure build: show build time
    const timeAgo = formatRelativeTime(stamp.buildTs)
    return `${versionStr} — built ${timeAgo}${dirtyNote}`
  }

  // Pure build: show commit time
  const timeAgo = formatRelativeTime(stamp.commitTs)
  return `${versionStr} — committed ${timeAgo}${dirtyNote}`
}

/**
 * Resolve the CLI version from build stamp and optional runtime stamp.
 *
 * @param baseVersion - The package.json version (used for local builds)
 * @param buildStamp - JSON stamp embedded at build time, or placeholder '__CLI_BUILD_STAMP__'
 * @param runtimeStampEnvVar - Environment variable name for runtime stamp (default: 'CLI_BUILD_STAMP')
 */
export const resolveCliVersion = (options: {
  baseVersion: string
  buildStamp: string
  runtimeStampEnvVar?: string
}): string => {
  const { baseVersion, buildStamp, runtimeStampEnvVar = 'CLI_BUILD_STAMP' } = options

  // Try to parse buildStamp as NixStamp (embedded at build time)
  const nixStamp = parseStamp(buildStamp)
  if (nixStamp?.type === 'nix') {
    // Nix build: use embedded stamp, ignore runtime stamp
    return renderNixVersion(nixStamp)
  }

  // Local/dev build: check for runtime stamp
  const runtimeStampRaw = process.env[runtimeStampEnvVar]?.trim()
  if (runtimeStampRaw) {
    const localStamp = parseStamp(runtimeStampRaw)
    if (localStamp?.type === 'local') {
      return renderLocalVersion(baseVersion, localStamp)
    }
  }

  // No valid stamp: just return base version
  return baseVersion
}
