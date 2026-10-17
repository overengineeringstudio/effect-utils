// Checked JavaScript so Node-loaded Vite configs and browsers share the same implementation.
// No imports: this subpath must stay browser-safe and dependency-free.

/** @param {{readonly ts: number, readonly now: number, readonly format?: 'short' | 'long'}} options @returns {string} */
export const formatRelativeTime = ({ ts, now, format = 'short' }) => {
  if (Number.isFinite(ts) === false || Number.isFinite(now) === false) return 'n/a'
  const seconds = Math.max(0, Math.floor(now - ts))
  if (seconds < 60) return format === 'long' ? 'just now' : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return format === 'long' ? `${minutes} min ago` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return format === 'long' ? `${hours} ${hours === 1 ? 'hour' : 'hours'} ago` : `${hours}h`
  const days = Math.floor(hours / 24)
  // Preserve CLI --version output; compact UI time has no week/calendar-date bucket.
  if (format === 'long') {
    if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
    if (days < 30) {
      const weeks = Math.floor(days / 7)
      return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
    }
    const date = new Date(ts * 1000)
    const month = date.toLocaleString('en-US', { month: 'short' })
    return `${month} ${date.getDate()}`
  }
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/**
 * @param {import('./build-identity-types.d.ts').BuildIdentityFormatOptions} options
 * @returns {string}
 */
export const formatBuildIdentityShort = ({ identity, now }) => {
  const rev = identity.rev === undefined || identity.rev === '' ? 'n/a' : identity.rev.slice(0, 7)
  const age =
    identity.commitTs === undefined ? 'n/a' : formatRelativeTime({ ts: identity.commitTs, now })
  return `${rev}${identity.dirty === true ? '*' : ''} · ${age}`
}

/**
 * @param {import('./build-identity-types.d.ts').BuildIdentityFormatOptions} options
 * @returns {readonly import('./build-identity-types.d.ts').BuildIdentityDetail[]}
 */
export const formatBuildIdentityDetails = ({ identity, now }) => {
  /** @type {import('./build-identity-types.d.ts').BuildIdentityDetail[]} */
  const lines = [
    { label: 'displayVersion', value: identity.displayVersion },
    { label: 'machineVersion', value: identity.machineVersion },
  ]
  if (identity.buildTs !== undefined) {
    const age = formatRelativeTime({ ts: identity.buildTs, now })
    lines.push({ label: 'deployed', value: age === 'n/a' ? age : `${age} ago` })
  }
  return lines
}
