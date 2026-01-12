# oxlint-config

Generate `oxlint.jsonc` configuration files for the [Oxc linter](https://oxc.rs/docs/guide/usage/linter).

## Usage

```ts
import { oxlintConfig } from '@overeng/genie/lib'

export default oxlintConfig({
  plugins: ['import', 'typescript', 'unicorn', 'oxc'],
  jsPlugins: ['./custom-rules.ts'],
  categories: {
    correctness: 'error',
    suspicious: 'warn',
    pedantic: 'off',
    perf: 'warn',
    style: 'off',
    restriction: 'off',
  },
  rules: {
    'import/no-cycle': 'warn',
    'oxc/no-barrel-file': ['warn', { threshold: 0 }],
  },
  overrides: [
    { files: ['**/mod.ts'], rules: { 'oxc/no-barrel-file': 'off' } },
    { files: ['**/*.test.ts'], rules: { 'import/no-cycle': 'off' } },
  ],
})
```

## Features

- **Type-safe**: All plugins, rules, and categories are fully typed
- **Schema included**: Generated config includes `$schema` for IDE support
- **Override support**: File-specific rule configurations

## Type Reference

See [oxlint configuration docs](https://oxc.rs/docs/guide/usage/linter/config) for detailed documentation.
