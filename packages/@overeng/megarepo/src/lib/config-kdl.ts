/**
 * KDL config format support for megarepo
 *
 * Reads `megarepo.kdl` and decodes it into a MegarepoConfig.
 *
 * Example megarepo.kdl:
 * ```kdl
 * members {
 *   effect "effect-ts/effect"
 *   overeng-beads-public "overengineeringstudio/overeng-beads-public"
 * }
 *
 * generators {
 *   vscode enabled=#true {
 *     color "#372d8e"
 *     colorEnvVar "MEGAREPO_COLOR"
 *   }
 * }
 *
 * lockSync {
 *   exclude "some-member"
 *   sharedLockSources {
 *     devenv source="effect" path=".nodes.devenv.locked"
 *   }
 * }
 * ```
 */

import { Effect, Schema } from 'effect'
import { parse, type Document, type Node } from '@overeng/kdl'
import { MegarepoConfig } from './config.ts'

/** Parse a megarepo.kdl string into a MegarepoConfig */
export const decodeMegarepoKdl = (content: string): Effect.Effect<MegarepoConfig, Error> =>
  Effect.gen(function* () {
    const doc = parse(content)
    const raw = kdlDocumentToConfigObject(doc)
    return yield* Schema.decodeUnknown(MegarepoConfig)(raw)
  })

/** Convert a KDL document AST to a plain config object for Schema decoding */
const kdlDocumentToConfigObject = (doc: Document): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  const membersNode = doc.findNodeByName('members')
  if (membersNode?.children) {
    const members: Record<string, string> = {}
    for (const child of membersNode.children.nodes) {
      const value = child.getArgument(0)
      if (typeof value === 'string') {
        members[child.getName()] = value
      }
    }
    result['members'] = members
  }

  const generatorsNode = doc.findNodeByName('generators')
  if (generatorsNode?.children) {
    result['generators'] = decodeGeneratorsNode(generatorsNode)
  }

  const lockSyncNode = doc.findNodeByName('lockSync')
  if (lockSyncNode?.children) {
    result['lockSync'] = decodeLockSyncNode(lockSyncNode)
  }

  return result
}

const decodeGeneratorsNode = (node: Node): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  const vscodeNode = node.children?.findNodeByName('vscode')
  if (vscodeNode) {
    const vscode: Record<string, unknown> = {}

    const enabled = vscodeNode.getProperty('enabled')
    if (enabled !== undefined) vscode['enabled'] = enabled

    if (vscodeNode.children) {
      for (const child of vscodeNode.children.nodes) {
        const name = child.getName()
        const value = child.getArgument(0)
        if (value !== undefined) {
          vscode[name] = value
        }
      }

      const excludeNode = vscodeNode.children.findNodeByName('exclude')
      if (excludeNode) {
        vscode['exclude'] = excludeNode.getArguments().filter((a): a is string => typeof a === 'string')
      }

      const settingsNode = vscodeNode.children.findNodeByName('settings')
      if (settingsNode?.children) {
        const settings: Record<string, unknown> = {}
        for (const child of settingsNode.children.nodes) {
          settings[child.getName()] = child.getArgument(0)
        }
        vscode['settings'] = settings
      }
    }

    result['vscode'] = vscode
  }

  return result
}

const decodeLockSyncNode = (node: Node): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  const enabled = node.getProperty('enabled')
  if (enabled !== undefined) result['enabled'] = enabled

  if (node.children) {
    const excludeArgs: string[] = []
    for (const child of node.children.findNodesByName('exclude')) {
      const arg = child.getArgument(0)
      if (typeof arg === 'string') excludeArgs.push(arg)
    }
    if (excludeArgs.length > 0) result['exclude'] = excludeArgs

    const sharedNode = node.children.findNodeByName('sharedLockSources')
    if (sharedNode?.children) {
      const shared: Record<string, unknown> = {}
      for (const child of sharedNode.children.nodes) {
        const source = child.getProperty('source')
        const path = child.getProperty('path')
        if (typeof source === 'string' && typeof path === 'string') {
          shared[child.getName()] = { source, path }
        }
      }
      result['sharedLockSources'] = shared
    }
  }

  return result
}

// =============================================================================
// KDL Encoding
// =============================================================================

/** Encode a MegarepoConfig to KDL format */
export const encodeMegarepoKdl = (config: MegarepoConfig): string => {
  const lines: string[] = []

  const memberEntries = Object.entries(config.members)
  if (memberEntries.length > 0) {
    lines.push('members {')
    for (const [name, source] of memberEntries) {
      lines.push(`  ${needsQuoting(name) ? `"${name}"` : name} "${source}"`)
    }
    lines.push('}')
  }

  // TODO: generators, lockSync encoding

  return lines.join('\n') + '\n'
}

const needsQuoting = (s: string): boolean =>
  /[^a-zA-Z0-9_-]/.test(s) || s.length === 0
