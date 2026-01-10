import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
  name: '@overeng/oxc-config',
  ...privatePackageDefaults,
  exports: {
    './lint': './lint.jsonc',
    './fmt': './fmt.jsonc',
    './plugin': './src/mod.ts',
  },
  devDependencies: [
    '@types/eslint',
    '@typescript-eslint/parser',
    '@typescript-eslint/rule-tester',
    'eslint',
    'typescript',
    'vitest',
  ],
})
