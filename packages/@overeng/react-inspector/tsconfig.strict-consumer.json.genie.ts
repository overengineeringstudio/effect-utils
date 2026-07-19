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
    // This project shares react-inspector's intentional Effect 3/4 test matrix.
    plugins: baseTsconfigCompilerOptions.plugins.map((plugin) =>
      Object.assign({}, plugin, {
        allowedDuplicatedPackages: ['effect'],
      }),
    ),
  },
  include: ['src/schema/effectSchema.tsx', 'src/schema/lineage.ts', 'test-d/**/*'],
  references: [],
} satisfies TSConfigArgs)
