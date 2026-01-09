import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/oxc-config',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    './lint': './lint.jsonc',
    './fmt': './fmt.jsonc',
    './plugin': './src/mod.ts',
  },
  devDependencies: ['@types/eslint', 'eslint', 'typescript', 'typescript-eslint', 'vitest'],
})
