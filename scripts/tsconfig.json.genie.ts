import { baseTsconfigCompilerOptions } from '../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../packages/@overeng/genie/src/runtime/mod.ts'

/** Check the real bootstrap CLIs and their complete import closure without emitting files. */
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    rootDir: '..',
    types: ['node', 'bun'],
    composite: false,
    noEmit: true,
  },
  include: ['editor-view-authority.ts', 'buck2-entrypoint.ts'],
  references: [],
} satisfies TSConfigArgs)
