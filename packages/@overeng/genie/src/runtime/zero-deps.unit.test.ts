import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Genie runtime modules are imported as TypeScript source by consumer `.genie.ts` files.
 * When these runtime modules have npm dependencies, consumers using megarepo symlinks
 * cannot resolve them (no node_modules at the symlink target).
 *
 * This test enforces that runtime modules have zero value imports from npm packages.
 * Type-only imports (`import type`) are allowed since they're erased at compile time.
 *
 * See: https://github.com/overengineeringstudio/effect-utils/issues/138
 */
describe('runtime zero-deps constraint', () => {
  const runtimeDir = __dirname

  const collectTsFiles = (dir: string): string[] => {
    const results: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...collectTsFiles(fullPath))
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        results.push(fullPath)
      }
    }
    return results
  }

  /**
   * Matches value imports from npm packages (not relative paths, not node: builtins).
   *
   * Catches:
   *   import { Foo } from 'effect'
   *   import { Foo } from '@effect/platform'
   *   import Foo from 'effect'
   *
   * Allows:
   *   import type { Foo } from 'effect'        (type-only, erased at compile time)
   *   import { Foo } from './local.ts'          (relative import)
   *   import { Foo } from '../other/mod.ts'     (relative import)
   *   import { Foo } from 'node:fs'             (Node.js builtin)
   */
  const VALUE_IMPORT_RE = /^import\s+(?!type\s).*from\s+['"](?!\.\.?\/|node:)([^'"]+)['"]/gm

  it('runtime files must not have value imports from npm packages', () => {
    const files = collectTsFiles(runtimeDir)
    const violations: Array<{ file: string; line: string; pkg: string }> = []

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      for (const line of content.split('\n')) {
        const match = VALUE_IMPORT_RE.exec(line)
        if (match) {
          violations.push({
            file: path.relative(runtimeDir, file),
            line: line.trim(),
            pkg: match[1]!,
          })
        }
        VALUE_IMPORT_RE.lastIndex = 0
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}: ${v.line}`)
        .join('\n')
      expect.fail(
        `Runtime modules must be dependency-free (see issue #138).\n` +
          `Found ${violations.length} value import(s) from npm packages:\n${details}\n\n` +
          `Use \`import type\` for type-only imports, or move the code to src/build/.`,
      )
    }
  })
})
