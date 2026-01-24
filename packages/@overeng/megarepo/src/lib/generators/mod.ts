/**
 * Megarepo Generators
 *
 * Generators create/update configuration files in the megarepo based on its members.
 */

import { Effect } from 'effect'

import type { AbsoluteDirPath, AbsoluteFilePath, MegarepoConfig } from '../config.ts'
import { generateNix } from './nix/mod.ts'
import { generateSchema } from './schema.ts'
import { generateVscode } from './vscode.ts'

export * from './nix/mod.ts'
export * from './schema.ts'
export * from './vscode.ts'

export type GeneratorOutput =
  | {
      readonly _tag: 'nix'
      readonly workspaceRoot: AbsoluteDirPath
      readonly envrcPath: AbsoluteFilePath
    }
  | { readonly _tag: 'vscode'; readonly path: AbsoluteFilePath }
  | { readonly _tag: 'schema'; readonly path: AbsoluteFilePath }

export interface GenerateAllOptions {
  /** Path to the nearest megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** Path to the outermost megarepo root */
  readonly outermostRoot: AbsoluteDirPath
  /** The megarepo config */
  readonly config: typeof MegarepoConfig.Type
}

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

    const schemaResult = yield* generateSchema({
      megarepoRoot: options.megarepoRoot,
      config: options.config,
    })
    outputs.push({ _tag: 'schema', path: schemaResult.path })

    return outputs
  }),
)
