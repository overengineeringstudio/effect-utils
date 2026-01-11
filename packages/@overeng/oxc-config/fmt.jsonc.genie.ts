import { oxfmtConfig } from '../genie/src/lib/mod.ts'

export default oxfmtConfig({
  semi: false,
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  trailingComma: 'all',
  // Import sorting configuration
  // Groups imports into 3 blocks separated by newlines:
  // 1. External packages (effect, @effect/*)
  // 2. Internal monorepo packages (@overeng/*)
  // 3. Relative imports (parent, sibling, index)
  experimentalSortImports: {
    groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
    internalPattern: ['@overeng/'],
    newlinesBetween: true,
  },
  experimentalSortPackageJson: true,
  // Ignore generated files
  ignorePatterns: ['**/*.gen.ts', '**/*.gen.tsx', '**/*.generated.ts', '**/*.generated.tsx'],
})
