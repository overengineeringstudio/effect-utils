import { baseTsconfigCompilerOptions, reactJsx } from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    lib: ['ES2023', 'DOM'],
    rootDir: '.',
    ...reactJsx,
    composite: true,
    noEmit: true,
  },
  include: ['src/schema/effectSchema.tsx', 'src/schema/lineage.ts', 'test-d/**/*'],
  references: [],
} satisfies TSConfigArgs)
