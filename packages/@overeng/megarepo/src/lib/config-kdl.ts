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
  const sections: string[] = []

  const memberEntries = Object.entries(config.members)
  if (memberEntries.length > 0) {
    const lines: string[] = []
    lines.push('members {')
    for (const [name, source] of memberEntries) {
      lines.push(`  ${kdlIdent(name)} "${source}"`)
    }
    lines.push('}')
    sections.push(lines.join('\n'))
  }

  if (config.generators !== undefined) {
    sections.push(encodeGenerators(config.generators))
  }

  if (config.lockSync !== undefined) {
    sections.push(encodeLockSync(config.lockSync))
  }

  return sections.join('\n\n') + '\n'
}

const encodeGenerators = (generators: NonNullable<MegarepoConfig['generators']>): string => {
  const lines: string[] = []
  lines.push('generators {')

  if (generators.vscode !== undefined) {
    const v = generators.vscode
    const props: string[] = []
    if (v.enabled !== undefined) props.push(`enabled=${kdlBool(v.enabled)}`)

    const children: string[] = []
    if (v.color !== undefined) children.push(`    color "${v.color}"`)
    if (v.colorEnvVar !== undefined) children.push(`    colorEnvVar "${v.colorEnvVar}"`)
    if (v.exclude !== undefined && v.exclude.length > 0) {
      children.push(`    exclude ${v.exclude.map((e) => `"${e}"`).join(' ')}`)
    }
    if (v.settings !== undefined) {
      const settingsEntries = Object.entries(v.settings)
      if (settingsEntries.length > 0) {
        children.push('    settings {')
        for (const [key, value] of settingsEntries) {
          children.push(`      ${kdlIdent(key)} ${kdlValue(value)}`)
        }
        children.push('    }')
      }
    }

    if (children.length > 0) {
      lines.push(`  vscode ${props.join(' ')}${props.length > 0 ? ' ' : ''}{`)
      lines.push(...children)
      lines.push('  }')
    } else if (props.length > 0) {
      lines.push(`  vscode ${props.join(' ')}`)
    }
  }

  lines.push('}')
  return lines.join('\n')
}

const encodeLockSync = (lockSync: NonNullable<MegarepoConfig['lockSync']>): string => {
  const lines: string[] = []
  const props: string[] = []
  if (lockSync.enabled !== undefined) props.push(`enabled=${kdlBool(lockSync.enabled)}`)

  const children: string[] = []
  if (lockSync.exclude !== undefined && lockSync.exclude.length > 0) {
    for (const member of lockSync.exclude) {
      children.push(`  exclude "${member}"`)
    }
  }
  if (lockSync.sharedLockSources !== undefined) {
    const entries = Object.entries(lockSync.sharedLockSources)
    if (entries.length > 0) {
      children.push('  sharedLockSources {')
      for (const [label, { source, path }] of entries) {
        children.push(`    ${kdlIdent(label)} source="${source}" path="${path}"`)
      }
      children.push('  }')
    }
  }

  if (children.length > 0) {
    lines.push(`lockSync ${props.join(' ')}${props.length > 0 ? ' ' : ''}{`)
    lines.push(...children)
    lines.push('}')
  } else if (props.length > 0) {
    lines.push(`lockSync ${props.join(' ')}`)
  } else {
    lines.push('lockSync')
  }

  return lines.join('\n')
}

/** Format a value as a KDL boolean */
const kdlBool = (v: boolean): string => (v ? '#true' : '#false')

/** Format an unknown value as a KDL value literal */
const kdlValue = (v: unknown): string => {
  if (typeof v === 'boolean') return kdlBool(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return `"${v}"`
  return `"${String(v)}"`
}

/** Quote a string as a KDL identifier if it contains special characters */
const kdlIdent = (s: string): string =>
  /[^a-zA-Z0-9_-]/.test(s) || s.length === 0 ? `"${s}"` : s
