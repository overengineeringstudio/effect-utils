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
    '@types/eslint': catalog['@types/eslint'],
    '@typescript-eslint/parser': catalog['@typescript-eslint/parser'],
    '@typescript-eslint/rule-tester': catalog['@typescript-eslint/rule-tester'],
    '@typescript-eslint/utils': catalog['@typescript-eslint/utils'],
    eslint: catalog.eslint,
    typescript: catalog.typescript,
    vitest: catalog.vitest,
  },
})
