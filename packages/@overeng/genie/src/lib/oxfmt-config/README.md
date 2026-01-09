# oxfmt-config

Generate `oxfmt.jsonc` configuration files for the [Oxc formatter](https://oxc.rs/docs/guide/usage/formatter).

## Usage

```ts
import { oxfmtConfig } from '@overeng/genie/lib'

export default oxfmtConfig({
  semi: false,
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  trailingComma: 'all',
  experimentalSortImports: {
    groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
    internalPattern: ['@myorg/'],
    newlinesBetween: true,
  },
  experimentalSortPackageJson: true,
})
```

## Features

- **Type-safe**: All formatter options are fully typed
- **Schema included**: Generated config includes `$schema` for IDE support
- **Import sorting**: Experimental import sorting configuration
- **Prettier migration**: Options compatible with Prettier for easy migration

## Type Reference

See [oxfmt documentation](https://oxc.rs/docs/guide/usage/formatter) and [Prettier migration guide](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier) for detailed documentation.
