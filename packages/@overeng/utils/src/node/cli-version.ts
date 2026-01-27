/**
 * Structured stamp data injected at build time or runtime.
 */
export interface CliStamp {
  /** Where this build came from: "local" (dev shell) or "nix" (nix build) */
  source: 'local' | 'nix'
  /** Git short revision */
  rev: string
  /** Unix timestamp in seconds */
  ts: number
  /** Whether there were uncommitted changes */
  dirty: boolean
}

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
 * Try to parse a stamp string as JSON. Returns undefined if not valid JSON
 * or if it's the legacy format.
 */
const parseStamp = (stamp: string): CliStamp | undefined => {
  try {
    const parsed = JSON.parse(stamp)
    // Validate it has the expected shape
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.source === 'string' &&
      typeof parsed.rev === 'string' &&
      typeof parsed.ts === 'number' &&
      typeof parsed.dirty === 'boolean'
    ) {
      return parsed as CliStamp
    }
  } catch {
    // Not JSON, likely legacy format
  }
  return undefined
}

/**
 * Render version string with human-friendly stamp information.
 *
 * Output examples (Variant 8 - Human sentence, medium time formatting):
 * - Local dirty:  "0.1.0 — running from local source (abc123, 5 min ago, with uncommitted changes)"
 * - Local clean:  "0.1.0 — running from local source (abc123, 2 hours ago)"
 * - Nix w/ stamp: "0.1.0+def456 — built 3 days ago"
 * - Nix no stamp: "0.1.0+def456"
 */
const renderVersion = (
  version: string,
  stamp: CliStamp | undefined,
  isLocalDev: boolean,
): string => {
  if (!stamp) {
    return version
  }

  const timeAgo = formatRelativeTime(stamp.ts)

  if (isLocalDev) {
    // Local dev build: show full context
    const dirtyNote = stamp.dirty ? ', with uncommitted changes' : ''
    return `${version} — running from local source (${stamp.rev}, ${timeAgo}${dirtyNote})`
  }

  // Nix build running in a dev shell: show when it was built
  return `${version} — built ${timeAgo}`
}

/**
 * Resolve the CLI version with an optional runtime stamp.
 *
 * baseVersion - The package.json version (always present at build time).
 * buildVersion - The build-time injected version or the placeholder.
 * runtimeStampEnvVar - Environment variable that provides a runtime stamp.
 */
export const resolveCliVersion: (options: {
  baseVersion: string
  buildVersion: string
  runtimeStampEnvVar: string
}) => string = ({ baseVersion, buildVersion, runtimeStampEnvVar }) => {
  const isPlaceholder = buildVersion === '__CLI_VERSION__' || buildVersion === baseVersion
  const stampRaw = process.env[runtimeStampEnvVar]?.trim()
  const hasStamp = stampRaw !== undefined && stampRaw !== ''

  // Try to parse as structured JSON stamp
  const stamp = hasStamp ? parseStamp(stampRaw) : undefined

  if (!isPlaceholder) {
    // Nix build: version was injected at build time
    return renderVersion(buildVersion, stamp, false)
  }

  // Local/dev build: placeholder still present
  if (stamp) {
    return renderVersion(baseVersion, stamp, true)
  }

  // Legacy format or no stamp - fall back to old behavior for compatibility
  if (hasStamp) {
    return `${baseVersion}+${stampRaw}`
  }

  return baseVersion
}
