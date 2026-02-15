/**
 * URL Matching for Nix Lock Sync
 *
 * Matches flake.lock input nodes to megarepo members by comparing URLs.
 * Handles various URL formats:
 * - GitHub: owner/repo extracted from locked.owner + locked.repo
 * - Git: direct URL comparison with normalization
 */

import type { LockedMember } from '../lock.ts'
import { type ParsedLockedInput, parseLockedInput } from './schema.ts'

// =============================================================================
// URL Normalization
// =============================================================================

/**
 * Normalize a GitHub URL to a canonical form for comparison
 * Handles:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo
 * - git@github.com:owner/repo.git
 */
export const normalizeGitHubUrl = (url: string): string | undefined => {
  // HTTPS format
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?(?:\/)?$/)
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`
  }

  // SSH format
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`
  }

  return undefined
}

/**
 * Normalize any git URL for comparison
 * Removes trailing .git and slashes
 */
export const normalizeGitUrl = (url: string): string => {
  return url.replace(/\.git$/, '').replace(/\/$/, '')
}

/**
 * Check if two URLs point to the same repository
 */
export const urlsMatch = ({ url1, url2 }: { url1: string; url2: string }): boolean => {
  // Try GitHub normalization first
  const github1 = normalizeGitHubUrl(url1)
  const github2 = normalizeGitHubUrl(url2)

  if (github1 !== undefined && github2 !== undefined) {
    return github1.toLowerCase() === github2.toLowerCase()
  }

  // Fall back to generic URL normalization
  return normalizeGitUrl(url1).toLowerCase() === normalizeGitUrl(url2).toLowerCase()
}

// =============================================================================
// Member Matching
// =============================================================================

/**
 * Result of matching a flake input to a megarepo member
 */
export interface MatchResult {
  /** Name of the matched megarepo member */
  readonly memberName: string
  /** The locked member data from megarepo.lock */
  readonly member: LockedMember
}

/**
 * Extract GitHub URL from a flake lock input
 */
const getGitHubUrlFromInput = (input: ParsedLockedInput): string | undefined => {
  if (input.type === 'github' && input.owner !== undefined && input.repo !== undefined) {
    return `https://github.com/${input.owner}/${input.repo}`
  }
  return undefined
}

/**
 * Match a flake lock node to a megarepo member by URL
 *
 * Matching strategy:
 * 1. For GitHub-type inputs: construct URL from owner/repo, match against member URLs
 * 2. For Git-type inputs: match URL directly against member URLs
 *
 * @param locked - The `locked` field from a FlakeLockNode
 * @param members - Map of member names to locked member data from megarepo.lock
 * @returns Match result if found, undefined otherwise
 */
export const matchLockedInputToMember = ({
  locked,
  members,
}: {
  locked: Record<string, unknown> | undefined
  members: Record<string, LockedMember>
}): MatchResult | undefined => {
  const parsed = parseLockedInput(locked)
  if (parsed === undefined) return undefined

  // GitHub type: match by owner/repo
  if (parsed.type === 'github') {
    const inputUrl = getGitHubUrlFromInput(parsed)
    if (inputUrl === undefined) return undefined

    for (const [memberName, member] of Object.entries(members)) {
      if (urlsMatch({ url1: member.url, url2: inputUrl }) === true) {
        return { memberName, member }
      }
    }
  }

  // Git type: match by URL
  if (parsed.type === 'git' && parsed.url !== undefined) {
    for (const [memberName, member] of Object.entries(members)) {
      if (urlsMatch({ url1: member.url, url2: parsed.url }) === true) {
        return { memberName, member }
      }
    }
  }

  return undefined
}

/**
 * Check if a locked input needs updating based on megarepo member commit
 *
 * @param locked - The `locked` field from a FlakeLockNode
 * @param member - The megarepo locked member to compare against
 * @returns true if the revisions differ and an update is needed
 */
export const needsRevUpdate = ({
  locked,
  member,
}: {
  locked: Record<string, unknown> | undefined
  member: LockedMember
}): boolean => {
  const parsed = parseLockedInput(locked)
  if (parsed?.rev === undefined) return false

  return parsed.rev !== member.commit
}
