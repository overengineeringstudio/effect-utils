/**
 * Shared oxlint/oxfmt configuration with custom JS plugin rules.
 *
 * Note on Nix build: The standard Nix oxlint binary (pkgs.oxlint) is compiled
 * from Rust and does NOT support JS plugins. To enable the custom `overeng/*`
 * rules defined in `./src/mod.ts`, we package the npm version of oxlint with
 * NAPI bindings via `nix/oxlint-npm.nix`. This uses Bun as the JS runtime.
 *
 * See `nix/oxlint-npm.nix` for update instructions when bumping oxlint version.
 */
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
