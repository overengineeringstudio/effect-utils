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
 * Generate VSCode workspace content
 */
export const generateVscodeContent = (options: VscodeGeneratorOptions): string => {
  const excludeSet = new Set(options.exclude ?? options.config.generators?.vscode?.exclude ?? [])

  const folders: VscodeWorkspace['folders'] = [
    { path: '.', name: '(megarepo root)' },
    ...Object.keys(options.config.members)
      .filter((name) => !excludeSet.has(name))
      .map((name) => ({ path: `${MEMBER_ROOT_DIR}/${name}`, name })),
  ]

  const workspace: VscodeWorkspace = {
    folders,
    settings: {
      'files.exclude': {
        '**/.git': true,
        '**/node_modules': true,
        '**/dist': true,
      },
    },
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
