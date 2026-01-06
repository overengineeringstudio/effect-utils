import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/oxc-config',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    './lint': './lint.jsonc',
    './fmt': './fmt.jsonc',
    './plugin': './src/mod.ts',
  },
  devDependencies: {
    '@types/eslint': '^9.6.1',
    eslint: '^9.28.0',
    typescript: catalogRef,
    'typescript-eslint': '^8.34.0',
    vitest: catalogRef,
  },
})
