import { baseTsconfigCompilerOptions, reactJsx } from '../../../genie/internal.ts'
import { tsconfigJson, type TSConfigArgs } from '../genie/src/runtime/mod.ts'

/** react-inspector is a git submodule with relaxed type checking for legacy code */
export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    lib: ['ES2023', 'DOM'],
    rootDir: '.',
    outDir: './dist',
    ...reactJsx,
    allowJs: true,
    checkJs: false,
    composite: true,
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    exactOptionalPropertyTypes: false,
    noUncheckedIndexedAccess: false,
    verbatimModuleSyntax: false,
    noImplicitReturns: false,
    noEmit: true,
  },
  include: ['src/**/*'],
  /**
   * The Buck TypeScript source census admits `.cts`, `.js`, `.mts`, `.ts` and
   * `.tsx`, so its compile tree carries no `.jsx`, `.cjs` or `.mjs`. The
   * standalone pack build must use the same exclusion: otherwise `allowJs`
   * emits extra JSX specs not present in the Buck-owned dist tree.
   */
  exclude: ['src/**/*.cjs', 'src/**/*.jsx', 'src/**/*.mjs'],
} satisfies TSConfigArgs)
