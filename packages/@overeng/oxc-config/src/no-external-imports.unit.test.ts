import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
})

const rule = plugin.rules['no-external-imports']

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

tsRuleTester.run('no-external-imports: valid relative imports', rule, {
  valid: [
    { code: `import { foo } from './foo.ts'` },
    { code: `import { bar } from '../bar/mod.ts'` },
    { code: `import { baz } from '../../common/types.ts'` },
  ],
  invalid: [],
})

tsRuleTester.run('no-external-imports: valid node builtins', rule, {
  valid: [
    { code: `import fs from 'node:fs'` },
    { code: `import { join } from 'node:path'` },
    { code: `import { createHash } from 'node:crypto'` },
  ],
  invalid: [],
})

tsRuleTester.run('no-external-imports: valid type-only imports', rule, {
  valid: [
    { code: `import type { Effect } from 'effect'` },
    { code: `import type { FileSystem, Path } from '@effect/platform'` },
    { code: `import type React from 'react'` },
    // Inline type specifiers
    { code: `import { type Effect } from 'effect'` },
    { code: `import { type Effect, type pipe } from 'effect'` },
    { code: `import { type FileSystem, type Path } from '@effect/platform'` },
  ],
  invalid: [],
})

tsRuleTester.run('no-external-imports: invalid value imports from npm', rule, {
  valid: [],
  invalid: [
    {
      code: `import { Effect } from 'effect'`,
      errors: [{ messageId: 'noExternalImport' }],
    },
    {
      code: `import { FileSystem, Path } from '@effect/platform'`,
      errors: [{ messageId: 'noExternalImport' }],
    },
    {
      code: `import React from 'react'`,
      errors: [{ messageId: 'noExternalImport' }],
    },
    {
      code: `import { pipe } from 'effect/Function'`,
      errors: [{ messageId: 'noExternalImport' }],
    },
    // Mixed: at least one value specifier means it's not type-only
    {
      code: `import { type Effect, pipe } from 'effect'`,
      errors: [{ messageId: 'noExternalImport' }],
    },
    // Side-effect import
    {
      code: `import 'effect'`,
      errors: [{ messageId: 'noExternalImport' }],
    },
  ],
})

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

tsRuleTester.run('no-external-imports: valid type-only re-exports', rule, {
  valid: [
    { code: `export type { PackageInfo } from 'effect'` },
    { code: `export { type Effect, type pipe } from 'effect'` },
    // Relative re-exports are always fine
    { code: `export { foo } from './foo.ts'` },
    { code: `export * from './mod.ts'` },
    // Node builtin re-exports
    { code: `export { join } from 'node:path'` },
  ],
  invalid: [],
})

tsRuleTester.run('no-external-imports: invalid value re-exports from npm', rule, {
  valid: [],
  invalid: [
    {
      code: `export { something } from 'effect'`,
      errors: [{ messageId: 'noExternalExport' }],
    },
    {
      code: `export * from '@effect/platform'`,
      errors: [{ messageId: 'noExternalExport' }],
    },
    // Mixed: at least one value specifier
    {
      code: `export { type Effect, pipe } from 'effect'`,
      errors: [{ messageId: 'noExternalExport' }],
    },
  ],
})
