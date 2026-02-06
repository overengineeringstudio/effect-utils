import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { RuleTester as ESLintRuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
ESLintRuleTester.describe = describe
ESLintRuleTester.it = it

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
})

const rule = plugin.rules['no-external-imports']

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
  ],
})
