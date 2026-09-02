import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  nodeTypes,
} from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...nodeTypes,
    // `src/node/stylex/mod.js` is checked JavaScript so Vite can load it from
    // `node_modules` without TypeScript stripping. See #1167.
    allowJs: true,
    checkJs: true,
    noEmit: true,
  },
  include: ['src/**/*'],
  references: [],
} satisfies TSConfigArgs)
