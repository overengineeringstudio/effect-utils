import { domLib, reactJsx } from '../../../../../genie/repo.ts'
import { tsconfigJSON } from '../../../genie/src/lib/mod.ts'

export default tsconfigJSON({
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
