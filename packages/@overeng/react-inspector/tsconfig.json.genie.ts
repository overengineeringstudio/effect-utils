import { reactJsx } from '../../../genie/repo.ts'
import { tsconfigJSON } from '../genie/src/runtime/mod.ts'

/** react-inspector is a git submodule with relaxed type checking for legacy code */
export default tsconfigJSON({
  extends: '../../../tsconfig.base.json',
  compilerOptions: {
    lib: ['ES2023', 'DOM'],
    rootDir: 'src',
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
  },
  include: ['src/**/*'],
})
