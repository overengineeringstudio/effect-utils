import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import inventory from '../../nix/buck2-products/production-helpers.json'
import cacheTargets from '../../nix/buck2-products/cache-targets.json.genie.ts'
import {
  applicationHelperEntries, helperBuckBlocks, helperImportClosure, helperRoot,
  productionHelperBuck, productionHelpers,
} from './production-helpers.ts'
import { buck2StagedRuntimes } from './runtime-modules.ts'

const source = readFileSync(`${helperRoot}/BUCK`, 'utf8')
const generated = readFileSync('nix/buck2-products/production-helpers.bzl', 'utf8')

describe('production helper projection', () => {
  it('commits the complete derived runtime and application import closure', () => {
    expect(productionHelpers(cacheTargets.data)).toEqual({
      files: inventory.files, applicationEntries: inventory.applicationEntries,
    })
    expect(helperImportClosure([
      ...buck2StagedRuntimes.map((runtime) => runtime.entry), ...inventory.applicationEntries,
    ])).toEqual(inventory.files.filter((file) => file.endsWith('.ts')))
    expect(inventory.applicationEntries).toContain(`${helperRoot}/src/editor-view-lifecycle.ts`)
    expect(inventory.files).toContain(`${helperRoot}/package.json`)
    expect(inventory.files).toContain(`${helperRoot}/tsconfig.json`)
    for (const file of inventory.files) {
      expect(existsSync(file)).toBe(true)
      expect(file).not.toMatch(/\.test\.|\.stories\.|\/fixtures\/|repository-validation-runner/)
    }
  })

  it('discovers subpath imports and rejects missing exports without a broad fallback', () => {
    expect(applicationHelperEntries("import { x } from '@overeng/buck2-tools/editor-view-lifecycle'"))
      .toEqual([`${helperRoot}/src/editor-view-lifecycle.ts`])
    expect(() => applicationHelperEntries("import '@overeng/buck2-tools/missing'"))
      .toThrow('Missing production helper export')
    expect(() => productionHelperBuck('', inventory.files)).toThrow('Missing production helper targets')
  })

  it('follows transitive imports and fails on a missing module', () => {
    mkdirSync('tmp', { recursive: true })
    const directory = mkdtempSync('tmp/production-helper-')
    try {
      const entry = `${directory}/entry.ts`
      const dependency = `${directory}/dependency.ts`
      writeFileSync(entry, "export { x } from './dependency.ts'\n")
      writeFileSync(dependency, 'export const x = 1\n')
      expect(helperImportClosure([entry])).toEqual([dependency, entry].toSorted())
      rmSync(dependency)
      expect(() => helperImportClosure([entry])).toThrow('Missing production helper module')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('copies every production target from development with identical non-source attributes', () => {
    expect(generated.startsWith('# Generated file - DO NOT EDIT\n')).toBe(true)
    expect(generated.split('\n').some((line) => line.startsWith('//'))).toBe(false)
    expect(generated.endsWith(productionHelperBuck(source, inventory.files))).toBe(true)
    const key = (block: string) => /\n    name = "([^"]+)",/.exec(block)?.[1] ?? block.split('(')[0]
    const withoutSources = (block: string) => block.split('\n')
      .filter((line) => !/^\s+"(?:src\/[^"\n]+|tsconfig\.json)"(?:\s*:.*)?,$/.test(line)).join('\n')
    const development = new Map(helperBuckBlocks(source).map((block) => [key(block), block]))
    for (const block of helperBuckBlocks(generated)) {
      const original = development.get(key(block))
      expect(original).toBeDefined()
      expect(withoutSources(block)).toBe(withoutSources(original!))
    }
  })
})
