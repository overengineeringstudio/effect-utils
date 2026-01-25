/**
 * Megarepo Generators
 *
 * Generators create/update configuration files in the megarepo based on its members.
 */

import { Effect } from 'effect'

import type { AbsoluteDirPath, AbsoluteFilePath, MegarepoConfig } from '../config.ts'
import { generateNix } from './nix/mod.ts'
import { generateVscode } from './vscode.ts'

export * from './nix/mod.ts'
export * from './schema.ts'
export * from './vscode.ts'

/** Output types from generator functions */
export type GeneratorOutput =
  | {
      readonly _tag: 'nix'
      readonly workspaceRoot: AbsoluteDirPath
      readonly envrcPath: AbsoluteFilePath
    }
  | { readonly _tag: 'vscode'; readonly path: AbsoluteFilePath }

/** Options for running all generators */
export interface GenerateAllOptions {
  /** Path to the nearest megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** Path to the outermost megarepo root */
  readonly outermostRoot: AbsoluteDirPath
  /** The megarepo config */
  readonly config: typeof MegarepoConfig.Type
}

/** Get list of generators that would run based on config */
export const getEnabledGenerators = (config: typeof MegarepoConfig.Type): string[] => {
  const generators: string[] = []
  if (config.generators?.nix?.enabled === true) {
    generators.push('.envrc.generated.megarepo')
    generators.push('.direnv/megarepo-nix/workspace')
  }
  if (config.generators?.vscode?.enabled === true) {
    generators.push('.vscode/megarepo.code-workspace')
  }
  return generators
}

/** Run all enabled generators and return their outputs */
export const generateAll = Effect.fn('megarepo/generate/all')((options: GenerateAllOptions) =>
  Effect.gen(function* () {
    const outputs: GeneratorOutput[] = []
    const nixEnabled = options.config.generators?.nix?.enabled === true
    const vscodeEnabled = options.config.generators?.vscode?.enabled === true

    if (nixEnabled) {
      const nixResult = yield* generateNix({
        megarepoRootNearest: options.megarepoRoot,
        megarepoRootOutermost: options.outermostRoot,
        config: options.config,
      })
      outputs.push({
        _tag: 'nix',
        workspaceRoot: nixResult.workspaceRoot,
        envrcPath: nixResult.envrcPath,
      })
    }

    if (vscodeEnabled) {
      const vscodeResult = yield* generateVscode({
        megarepoRoot: options.megarepoRoot,
        config: options.config,
      })
      outputs.push({ _tag: 'vscode', path: vscodeResult.path })
    }

    return outputs
  }),
)
