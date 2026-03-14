/**
 * Source file URL rewriter for flake.nix, devenv.yaml, and lock files.
 *
 * Rewrites ref/rev values in input URL declarations while preserving
 * all surrounding formatting, comments, and expressions.
 */

import { parseNixFlakeUrl, updateNixFlakeUrl } from './flake-url.ts'

// =============================================================================
// Types
// =============================================================================

export interface SourceUrlUpdate {
  /** The upstream megarepo member name this input maps to */
  readonly memberName: string
  /** New ref to set (undefined = don't change, null = remove) */
  readonly newRef?: string | null
  /** New rev to set (undefined = don't change, null = remove) */
  readonly newRev?: string | null
}

// =============================================================================
// flake.nix rewriter
// =============================================================================

/**
 * Rewrite input URLs in a flake.nix file.
 *
 * Finds `inputs.<name>.url = "..."` declarations and applies ref/rev updates
 * for matching inputs. Only the URL string between quotes is changed.
 */
export const rewriteFlakeNixUrls = (args: {
  content: string
  updates: ReadonlyMap<string, SourceUrlUpdate>
}): { content: string; updatedInputs: string[] } => {
  const { content, updates } = args
  const updatedInputs: string[] = []

  // Same regex as extractFlakeNixInputs in input-discovery.ts
  const pattern = /(?:inputs\.)?([a-zA-Z0-9_-]+)\.url\s*=\s*"([^"]+)"/g

  const newContent = content.replace(pattern, (fullMatch, inputName: string, url: string) => {
    const update = updates.get(inputName)
    if (update === undefined) return fullMatch

    const parsed = parseNixFlakeUrl(url)
    if (parsed === undefined) return fullMatch

    const updateArgs: { ref?: string | null; rev?: string | null } = {}
    if ('newRef' in update) updateArgs.ref = update.newRef
    if ('newRev' in update) updateArgs.rev = update.newRev

    const newUrl = updateNixFlakeUrl(url, updateArgs)
    if (newUrl === url) return fullMatch

    updatedInputs.push(inputName)
    return fullMatch.replace(`"${url}"`, `"${newUrl}"`)
  })

  return { content: newContent, updatedInputs }
}

// =============================================================================
// devenv.yaml rewriter
// =============================================================================

/**
 * Rewrite input URLs in a devenv.yaml file.
 *
 * Finds `url: VALUE` lines under `inputs.<name>` and applies ref/rev updates.
 * Only the URL value on matching lines is changed.
 */
export const rewriteDevenvYamlUrls = (args: {
  content: string
  updates: ReadonlyMap<string, SourceUrlUpdate>
}): { content: string; updatedInputs: string[] } => {
  const { content, updates } = args
  const updatedInputs: string[] = []
  const lines = content.split('\n')

  let inInputs = false
  let currentInputName: string | undefined = undefined
  let inputsIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    if (trimmed === 'inputs:') {
      inInputs = true
      inputsIndent = indent
      currentInputName = undefined
      continue
    }

    if (!inInputs) continue

    if (trimmed !== '' && indent <= inputsIndent && !trimmed.startsWith('#')) {
      inInputs = false
      currentInputName = undefined
      continue
    }

    const inputNameMatch = trimmed.match(/^([a-zA-Z0-9_-]+):$/)
    if (inputNameMatch !== null && indent > inputsIndent) {
      currentInputName = inputNameMatch[1]!
      continue
    }

    if (currentInputName !== undefined) {
      const urlMatch = trimmed.match(/^url:\s*(.+)$/)
      if (urlMatch !== null) {
        const update = updates.get(currentInputName)
        if (update === undefined) continue

        const rawValue = urlMatch[1]!.trim()
        const isDoubleQuoted = rawValue.startsWith('"') && rawValue.endsWith('"')
        const isSingleQuoted = rawValue.startsWith("'") && rawValue.endsWith("'")
        const cleanUrl = isDoubleQuoted || isSingleQuoted ? rawValue.slice(1, -1) : rawValue

        const parsed = parseNixFlakeUrl(cleanUrl)
        if (parsed === undefined) continue

        const updateArgs: { ref?: string | null; rev?: string | null } = {}
        if ('newRef' in update) updateArgs.ref = update.newRef
        if ('newRev' in update) updateArgs.rev = update.newRev

        const newUrl = updateNixFlakeUrl(cleanUrl, updateArgs)
        if (newUrl === cleanUrl) continue

        const newValue = isDoubleQuoted ? `"${newUrl}"` : isSingleQuoted ? `'${newUrl}'` : newUrl
        lines[i] = line.replace(rawValue, newValue)
        updatedInputs.push(currentInputName)
      }
    }
  }

  return { content: lines.join('\n'), updatedInputs }
}

// =============================================================================
// Lock file rewriter
// =============================================================================

/**
 * Rewrite `original.ref` fields in a flake.lock or devenv.lock file.
 *
 * Parses the lock file as JSON, updates matching `original.ref` values,
 * and serializes back preserving the standard 2-space indent formatting.
 */
export const rewriteLockFileRefs = (args: {
  content: string
  refUpdates: ReadonlyMap<string, string>
}): { content: string; updatedNodes: string[] } => {
  const { content, refUpdates } = args
  const updatedNodes: string[] = []

  let parsed: { nodes?: Record<string, Record<string, unknown>> }
  try {
    parsed = JSON.parse(content) as { nodes?: Record<string, Record<string, unknown>> }
  } catch {
    return { content, updatedNodes }
  }

  if (parsed.nodes === undefined) return { content, updatedNodes }

  for (const [nodeName, newRef] of refUpdates) {
    const node = parsed.nodes[nodeName]
    if (node === undefined) continue

    const original = node['original'] as Record<string, unknown> | undefined
    if (original === undefined) continue

    original['ref'] = newRef
    updatedNodes.push(nodeName)
  }

  const newContent = JSON.stringify(parsed, null, 2) + '\n'
  return { content: newContent, updatedNodes }
}
