# tsconfig-json

Generate `tsconfig.json` files with TypeScript compiler options.

## Usage

```ts
import { tsconfigJSON } from '@overeng/genie/lib'

export default tsconfigJSON({
  extends: '../tsconfig.base.json',
  compilerOptions: {
    composite: true,
    rootDir: '.',
    outDir: './dist',
  },
  include: ['src/**/*.ts'],
  references: [{ path: '../other-package' }],
})
```

## Features

- **Type-safe options**: All TypeScript compiler options are fully typed
- **Complete coverage**: Supports all tsconfig fields including watch options and ts-node configuration
- **Reference support**: Project references for monorepo setups

## Type Reference

See [TypeScript tsconfig reference](https://www.typescriptlang.org/tsconfig) for detailed documentation on all compiler options.
