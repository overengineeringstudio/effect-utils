import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/oxc-config',
  ...privatePackageDefaults,
  exports: {
    './lint': './lint.jsonc',
    './fmt': './fmt.jsonc',
    './plugin': './src/mod.ts',
  },
  devDependencies: {
    ...catalog.pick(
      '@types/eslint',
      '@typescript-eslint/parser',
      '@typescript-eslint/rule-tester',
      '@typescript-eslint/utils',
      'eslint',
      'typescript',
      'vitest',
    ),
  },
})
