import { domLib, reactJsx } from '../../../../../genie/internal.ts'
import { tsconfigJson } from '../../../genie/src/runtime/mod.ts'

export default tsconfigJson({
  compilerOptions: {
    target: 'ES2022',
    lib: [...domLib],
    module: 'ESNext',
    moduleResolution: 'bundler',
    allowImportingTsExtensions: true,
    ...reactJsx,
    strict: true,
    noUncheckedIndexedAccess: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    isolatedModules: true,
    noEmit: true,
  },
  include: ['src/**/*', 'vite.config.ts'],
})
