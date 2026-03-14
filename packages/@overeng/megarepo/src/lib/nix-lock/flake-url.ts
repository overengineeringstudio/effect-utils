/**
 * Nix Flake URL Parser, Serializer, and Updater
 *
 * Handles all 5 URL variants found in the workspace:
 * 1. github:owner/repo[/ref][?dir=...]
 * 2. git+https://github.com/owner/repo[?ref=...][&rev=...][&dir=...]
 * 3. git+ssh://git@github.com/owner/repo[.git][?ref=...][&rev=...]
 * 4. github:owner/repo?dir=path (no ref, just query params)
 * 5. Combinations of the above with various query param orderings
 */

// =============================================================================
// Types
// =============================================================================

/** Parsed Nix flake URL with all components extracted */
export type NixFlakeUrl =
  | {
      /** github: scheme (e.g. `github:owner/repo/ref`) */
      readonly scheme: 'github'
      readonly owner: string
      readonly repo: string
      /** Branch/tag ref embedded in path (github:owner/repo/ref) */
      readonly ref: string | undefined
      /** Query parameters (e.g. dir) */
      readonly params: ReadonlyMap<string, string>
    }
  | {
      /** git+https: scheme */
      readonly scheme: 'git+https'
      readonly owner: string
      readonly repo: string
      /** Whether the URL had .git suffix */
      readonly dotGit: boolean
      /** Query parameters (ref, rev, dir, etc.) */
      readonly params: ReadonlyMap<string, string>
    }
  | {
      /** git+ssh: scheme */
      readonly scheme: 'git+ssh'
      readonly owner: string
      readonly repo: string
      /** Whether the URL had .git suffix */
      readonly dotGit: boolean
      /** Query parameters (ref, rev, dir, etc.) */
      readonly params: ReadonlyMap<string, string>
    }

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse a Nix flake URL string into a structured NixFlakeUrl.
 *
 * Supports:
 * - `github:owner/repo[/ref][?params]`
 * - `git+https://github.com/owner/repo[.git][?params]`
 * - `git+ssh://git@github.com/owner/repo[.git][?params]`
 */
export const parseNixFlakeUrl = (url: string): NixFlakeUrl | undefined => {
  // Split URL and query string
  const qIdx = url.indexOf('?')
  const base = qIdx >= 0 ? url.slice(0, qIdx) : url
  const params = qIdx >= 0 ? parseQueryString(url.slice(qIdx + 1)) : new Map<string, string>()

  // Pattern 1: github:owner/repo[/ref...]
  if (base.startsWith('github:') === true) {
    const rest = base.slice('github:'.length)
    const parts = rest.split('/')
    if (parts.length < 2) return undefined

    const owner = parts[0]!
    const repo = parts[1]!
    if (owner === '' || repo === '') return undefined

    // Everything after owner/repo is the ref (can contain slashes)
    const ref = parts.length > 2 ? parts.slice(2).join('/') : undefined

    return { scheme: 'github', owner, repo, ref, params }
  }

  // Pattern 2: git+https://github.com/owner/repo[.git]
  if (base.startsWith('git+https://github.com/') === true) {
    const path = base.slice('git+https://github.com/'.length)
    return parseGitPath({ path, scheme: 'git+https', params })
  }

  // Pattern 3: git+ssh://git@github.com/owner/repo[.git]
  if (base.startsWith('git+ssh://git@github.com/') === true) {
    const path = base.slice('git+ssh://git@github.com/'.length)
    return parseGitPath({ path, scheme: 'git+ssh', params })
  }

  return undefined
}

const parseGitPath = ({
  path,
  scheme,
  params,
}: {
  path: string
  scheme: 'git+https' | 'git+ssh'
  params: ReadonlyMap<string, string>
}): NixFlakeUrl | undefined => {
  const dotGit = path.endsWith('.git')
  const cleanPath = dotGit === true ? path.slice(0, -4) : path
  const parts = cleanPath.split('/')
  if (parts.length < 2) return undefined

  const owner = parts[0]!
  const repo = parts[1]!
  if (owner === '' || repo === '') return undefined

  return { scheme, owner, repo, dotGit, params }
}

/** Parse a query string into an ordered Map (preserves param order) */
const parseQueryString = (qs: string): Map<string, string> => {
  const result = new Map<string, string>()
  if (qs === '') return result

  for (const pair of qs.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx >= 0) {
      result.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1))
    } else {
      result.set(pair, '')
    }
  }
  return result
}

// =============================================================================
// Serializer
// =============================================================================

/**
 * Serialize a NixFlakeUrl back to its string form.
 * Round-trips: `serializeNixFlakeUrl(parseNixFlakeUrl(url)) === url`
 */
export const serializeNixFlakeUrl = (parsed: NixFlakeUrl): string => {
  let base: string

  switch (parsed.scheme) {
    case 'github': {
      base = `github:${parsed.owner}/${parsed.repo}`
      if (parsed.ref !== undefined) {
        base += `/${parsed.ref}`
      }
      break
    }
    case 'git+https': {
      base = `git+https://github.com/${parsed.owner}/${parsed.repo}`
      if (parsed.dotGit === true) base += '.git'
      break
    }
    case 'git+ssh': {
      base = `git+ssh://git@github.com/${parsed.owner}/${parsed.repo}`
      if (parsed.dotGit === true) base += '.git'
      break
    }
  }

  const qs = serializeQueryString(parsed.params)
  return qs !== '' ? `${base}?${qs}` : base
}

const serializeQueryString = (params: ReadonlyMap<string, string>): string => {
  if (params.size === 0) return ''
  const parts: string[] = []
  for (const [key, value] of params) {
    parts.push(value === '' ? key : `${key}=${value}`)
  }
  return parts.join('&')
}

// =============================================================================
// Updater
// =============================================================================

/**
 * Update ref and/or rev in a Nix flake URL string.
 * Preserves scheme, dir, and other query params.
 */
export const updateNixFlakeUrl = ({
  url,
  updates,
}: {
  url: string
  updates: { ref?: string | null; rev?: string | null }
}): string => {
  const parsed = parseNixFlakeUrl(url)
  if (parsed === undefined) return url

  const newParams = new Map(parsed.params)

  if (parsed.scheme === 'github') {
    // For github: scheme, ref is embedded in the path
    let newRef = parsed.ref
    if ('ref' in updates) {
      newRef = updates.ref ?? undefined
    }

    // rev goes in query params for github: scheme (rare but possible)
    if ('rev' in updates) {
      if (updates.rev !== undefined && updates.rev !== null) {
        newParams.set('rev', updates.rev)
      } else {
        newParams.delete('rev')
      }
    }

    return serializeNixFlakeUrl({ ...parsed, ref: newRef, params: newParams })
  }

  // For git+https and git+ssh, ref and rev are query params
  if ('ref' in updates) {
    if (updates.ref !== undefined && updates.ref !== null) {
      newParams.set('ref', updates.ref)
    } else {
      newParams.delete('ref')
    }
  }

  if ('rev' in updates) {
    if (updates.rev !== undefined && updates.rev !== null) {
      newParams.set('rev', updates.rev)
    } else {
      newParams.delete('rev')
    }
  }

  return serializeNixFlakeUrl({ ...parsed, params: newParams })
}

// =============================================================================
// Helpers
// =============================================================================

/** Extract (owner, repo) from a NixFlakeUrl for matching */
export const getOwnerRepo = (parsed: NixFlakeUrl): { owner: string; repo: string } => ({
  owner: parsed.owner,
  repo: parsed.repo,
})

/** Get the ref from a NixFlakeUrl (either path-embedded or query param) */
export const getRef = (parsed: NixFlakeUrl): string | undefined => {
  if (parsed.scheme === 'github') {
    return parsed.ref
  }
  return parsed.params.get('ref')
}

/** Get the rev from a NixFlakeUrl */
export const getRev = (parsed: NixFlakeUrl): string | undefined => {
  return parsed.params.get('rev')
}

/** Get the dir from a NixFlakeUrl */
export const getDir = (parsed: NixFlakeUrl): string | undefined => {
  return parsed.params.get('dir')
}
