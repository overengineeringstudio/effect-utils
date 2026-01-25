/**
 * VSCode Workspace Generator
 *
 * Generates a VSCode workspace file that includes all member repos.
 * Output: .vscode/megarepo.code-workspace in the megarepo root.
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import {
  type AbsoluteDirPath,
  EffectPath,
  MEMBER_ROOT_DIR,
  type MegarepoConfig,
} from '../config.ts'

/** Options for the VSCode workspace generator */
export interface VscodeGeneratorOptions {
  /** Path to the megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** The megarepo config */
  readonly config: typeof MegarepoConfig.Type
  /** Members to exclude from workspace */
  readonly exclude?: ReadonlyArray<string>
}

interface VscodeWorkspace {
  folders: Array<{ path: string; name?: string }>
  settings?: Record<string, unknown>
}

/**
 * Generate color customizations from a single accent color.
 * Creates a consistent "branded" look for titleBar, activityBar, and statusBar.
 */
const generateColorCustomizations = (color: string): Record<string, string> => ({
  'titleBar.activeBackground': color,
  'titleBar.activeForeground': '#FFFFFF',
  'titleBar.inactiveBackground': color,
  'titleBar.inactiveForeground': '#CCCCCC',
  'activityBar.background': color,
  'activityBar.foreground': '#FFFFFF',
  'statusBar.background': color,
  'statusBar.foreground': '#FFFFFF',
})

/**
 * Deep merge two objects. Source values override target values.
 * For nested objects, merges recursively. For arrays and primitives, source wins.
 */
const deepMerge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      )
    } else {
      result[key] = sourceVal
    }
  }
  return result
}

/**
 * Generate VSCode workspace content
 */
export const generateVscodeContent = (options: VscodeGeneratorOptions): string => {
  const vscodeConfig = options.config.generators?.vscode
  const excludeSet = new Set(options.exclude ?? vscodeConfig?.exclude ?? [])

  // Paths are relative to .vscode/ directory where the workspace file lives
  const folders: VscodeWorkspace['folders'] = [
    { path: '..', name: '(megarepo root)' },
    ...Object.keys(options.config.members)
      .filter((name) => !excludeSet.has(name))
      .map((name) => ({ path: `../${MEMBER_ROOT_DIR}/${name}`, name })),
  ]

  // Build settings: defaults -> color shorthand -> user settings (in order of precedence)
  let settings: Record<string, unknown> = {
    'files.exclude': {
      '**/.git': true,
      '**/node_modules': true,
      '**/dist': true,
    },
  }

  // Apply color shorthand if provided
  if (vscodeConfig?.color) {
    settings = deepMerge(settings, {
      'workbench.colorCustomizations': generateColorCustomizations(vscodeConfig.color),
    })
  }

  // Apply user settings passthrough (overrides everything)
  if (vscodeConfig?.settings) {
    settings = deepMerge(settings, vscodeConfig.settings as Record<string, unknown>)
  }

  const workspace: VscodeWorkspace = {
    folders,
    settings,
  }

  return JSON.stringify(workspace, null, 2) + '\n'
}

/**
 * Generate VSCode workspace file
 */
export const generateVscode = (options: VscodeGeneratorOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const content = generateVscodeContent(options)
    const vscodeDir = EffectPath.ops.join(
      options.megarepoRoot,
      EffectPath.unsafe.relativeDir('.vscode/'),
    )
    const outputPath = EffectPath.ops.join(
      vscodeDir,
      EffectPath.unsafe.relativeFile('megarepo.code-workspace'),
    )

    // Ensure .vscode directory exists
    yield* fs.makeDirectory(vscodeDir, { recursive: true })
    yield* fs.writeFileString(outputPath, content)

    return { path: outputPath, content }
  })
