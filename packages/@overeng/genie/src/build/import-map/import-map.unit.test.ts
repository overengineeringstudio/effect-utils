import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileSystem } from '@effect/platform'
import { NodeFileSystem } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect } from 'vitest'

import {
  extractImportMap,
  findNearestPackageJson,
  findPackageJsonWithImports,
  isImportMapSpecifier,
  resolveImportMapSpecifier,
  resolveImportMapSpecifierForImporter,
  resolveImportMapSpecifierForImporterSync,
  resolveImportMapsInSource,
} from './mod.ts'

const TestLayer = NodeFileSystem.layer

/** Type-safe JSON stringify using Schema */
const toJson = Schema.encodeSync(Schema.parseJson(Schema.Unknown))

/** Create a temp directory for each test */
const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tempBase = os.tmpdir()
  const tempDir = path.join(
    tempBase,
    `genie-import-map-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  yield* fs.makeDirectory(tempDir, { recursive: true })
  return tempDir
})

/** Remove temp directory */
const removeTempDir = Effect.fnUntraced(
  function* (tempDir: string) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(tempDir, { recursive: true })
  },
  Effect.catchAll(() => Effect.void),
)

/** Write a file with content */
const writeFile = Effect.fnUntraced(function* (filePath: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  const dir = path.dirname(filePath)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(filePath, content)
})

describe('import-map', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await Effect.runPromise(makeTempDir.pipe(Effect.provide(TestLayer)))
  })

  afterEach(async () => {
    await Effect.runPromise(removeTempDir(tempDir).pipe(Effect.provide(TestLayer)))
  })

  describe('findNearestPackageJson', () => {
    it.effect(
      'finds package.json in the same directory',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(packageJsonPath, '{}')
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findNearestPackageJson(filePath)
        expect(Option.getOrNull(result)).toBe(packageJsonPath)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'finds package.json in parent directory',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(packageJsonPath, '{}')
        const filePath = path.join(tempDir, 'src', 'deep', 'nested', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findNearestPackageJson(filePath)
        expect(Option.getOrNull(result)).toBe(packageJsonPath)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'finds nearest package.json when multiple exist',
      Effect.fnUntraced(function* () {
        // Root package.json
        yield* writeFile(path.join(tempDir, 'package.json'), '{"name": "root"}')
        // Nested package.json
        const nestedDir = path.join(tempDir, 'packages', 'sub')
        const nestedPackageJson = path.join(nestedDir, 'package.json')
        yield* writeFile(nestedPackageJson, '{"name": "sub"}')
        // File in nested package
        const filePath = path.join(nestedDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findNearestPackageJson(filePath)
        expect(Option.getOrNull(result)).toBe(nestedPackageJson)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns None when no package.json exists',
      Effect.fnUntraced(function* () {
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findNearestPackageJson(filePath)
        expect(Option.isNone(result)).toBe(true)
      }, Effect.provide(TestLayer)),
    )
  })

  describe('findPackageJsonWithImports', () => {
    it.effect(
      'finds package.json with imports field',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            name: 'test',
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findPackageJsonWithImports(filePath)
        expect(Option.getOrNull(result)).toBe(packageJsonPath)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'skips package.json without imports and finds one with imports',
      Effect.fnUntraced(function* () {
        // Root package.json with imports
        const rootPackageJson = path.join(tempDir, 'package.json')
        yield* writeFile(
          rootPackageJson,
          toJson({
            name: 'root',
            imports: { '#genie/*': './lib/*' },
          }),
        )
        // Nested package.json without imports
        const nestedDir = path.join(tempDir, 'packages', 'sub')
        yield* writeFile(path.join(nestedDir, 'package.json'), '{"name": "sub"}')
        // File in nested package
        const filePath = path.join(nestedDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findPackageJsonWithImports(filePath)
        expect(Option.getOrNull(result)).toBe(rootPackageJson)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns None when no package.json with imports exists',
      Effect.fnUntraced(function* () {
        // Package.json without imports
        yield* writeFile(path.join(tempDir, 'package.json'), '{"name": "test"}')
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const result = yield* findPackageJsonWithImports(filePath)
        expect(Option.isNone(result)).toBe(true)
      }, Effect.provide(TestLayer)),
    )
  })

  describe('extractImportMap', () => {
    it.effect(
      'extracts imports field from package.json',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            name: 'test',
            imports: {
              '#lib/*': './src/lib/*',
              '#utils': './src/utils/mod.ts',
            },
          }),
        )

        const result = yield* extractImportMap(packageJsonPath)
        expect(result).toEqual({
          '#lib/*': './src/lib/*',
          '#utils': './src/utils/mod.ts',
        })
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns empty object when imports field is missing',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(packageJsonPath, toJson({ name: 'test' }))

        const result = yield* extractImportMap(packageJsonPath)
        expect(result).toEqual({})
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns empty object when file does not exist',
      Effect.fnUntraced(function* () {
        const result = yield* extractImportMap(path.join(tempDir, 'nonexistent.json'))
        expect(result).toEqual({})
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns empty object when file is invalid JSON',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(packageJsonPath, 'not valid json')

        const result = yield* extractImportMap(packageJsonPath)
        expect(result).toEqual({})
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'extracts imports from package.json.genie.ts when package.json has no imports (bootstrap)',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        const genieSourcePath = path.join(tempDir, 'package.json.genie.ts')

        // package.json exists but has no imports
        yield* writeFile(packageJsonPath, toJson({ name: 'test' }))

        // genie source has imports
        yield* writeFile(
          genieSourcePath,
          `import { workspaceRoot } from './genie/internal.ts'

export default workspaceRoot({
  name: 'test',
  private: true,
  imports: {
    '#genie/*': './submodules/effect-utils/packages/@overeng/genie/src/runtime/*',
  },
})`,
        )

        const result = yield* extractImportMap(packageJsonPath)
        expect(result).toEqual({
          '#genie/*': './submodules/effect-utils/packages/@overeng/genie/src/runtime/*',
        })
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'prefers package.json imports over genie source',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        const genieSourcePath = path.join(tempDir, 'package.json.genie.ts')

        // package.json has imports
        yield* writeFile(
          packageJsonPath,
          toJson({
            name: 'test',
            imports: { '#lib/*': './dist/lib/*' },
          }),
        )

        // genie source has different imports
        yield* writeFile(genieSourcePath, `export default { imports: { '#lib/*': './src/lib/*' } }`)

        const result = yield* extractImportMap(packageJsonPath)
        expect(result).toEqual({ '#lib/*': './dist/lib/*' })
      }, Effect.provide(TestLayer)),
    )
  })

  describe('isImportMapSpecifier', () => {
    it('returns true for # prefixed specifiers', () => {
      expect(isImportMapSpecifier('#genie/mod.ts')).toBe(true)
      expect(isImportMapSpecifier('#lib')).toBe(true)
      expect(isImportMapSpecifier('#')).toBe(true)
    })

    it('returns false for non-# specifiers', () => {
      expect(isImportMapSpecifier('./mod.ts')).toBe(false)
      expect(isImportMapSpecifier('../lib/mod.ts')).toBe(false)
      expect(isImportMapSpecifier('effect')).toBe(false)
      expect(isImportMapSpecifier('@effect/platform')).toBe(false)
    })
  })

  describe('resolveImportMapSpecifier', () => {
    const packageJsonDir = '/project'

    it('resolves exact match', () => {
      const result = resolveImportMapSpecifier({
        specifier: '#utils',
        importMap: { '#utils': './src/utils/mod.ts' },
        packageJsonDir,
      })
      expect(result).toBe('/project/src/utils/mod.ts')
    })

    it('resolves wildcard pattern', () => {
      const result = resolveImportMapSpecifier({
        specifier: '#genie/mod.ts',
        importMap: {
          '#genie/*': './submodules/effect-utils/packages/@overeng/genie/src/runtime/*',
        },
        packageJsonDir,
      })
      expect(result).toBe(
        '/project/submodules/effect-utils/packages/@overeng/genie/src/runtime/mod.ts',
      )
    })

    it('resolves nested wildcard path', () => {
      const result = resolveImportMapSpecifier({
        specifier: '#genie/package-json/mod.ts',
        importMap: { '#genie/*': './lib/*' },
        packageJsonDir,
      })
      expect(result).toBe('/project/lib/package-json/mod.ts')
    })

    it('returns null for unmatched specifier', () => {
      const result = resolveImportMapSpecifier({
        specifier: '#unknown/mod.ts',
        importMap: { '#genie/*': './lib/*' },
        packageJsonDir,
      })
      expect(result).toBe(null)
    })

    it('prefers exact match over wildcard', () => {
      const result = resolveImportMapSpecifier({
        specifier: '#genie/mod.ts',
        importMap: {
          '#genie/mod.ts': './exact/mod.ts',
          '#genie/*': './wildcard/*',
        },
        packageJsonDir,
      })
      expect(result).toBe('/project/exact/mod.ts')
    })
  })

  describe('resolveImportMapSpecifierForImporter', () => {
    it.effect(
      'resolves a specifier using the nearest import map',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            name: 'test',
            imports: { '#genie/*': './genie/*' },
          }),
        )

        const importerPath = path.join(tempDir, 'src', 'genie-file.ts')
        yield* writeFile(importerPath, '')

        const resolved = yield* resolveImportMapSpecifierForImporter({
          specifier: '#genie/mod.ts',
          importerPath,
        })

        expect(Option.getOrNull(resolved)).toBe(path.join(tempDir, 'genie', 'mod.ts'))
      }, Effect.provide(TestLayer)),
    )
  })

  describe('resolveImportMapSpecifierForImporterSync', () => {
    it.effect(
      'resolves a specifier using the nearest import map',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            name: 'test',
            imports: { '#genie/*': './genie/*' },
          }),
        )

        const importerPath = path.join(tempDir, 'src', 'genie-file.ts')
        yield* writeFile(importerPath, '')

        const resolved = resolveImportMapSpecifierForImporterSync({
          specifier: '#genie/mod.ts',
          importerPath,
        })

        expect(resolved).toBe(path.join(tempDir, 'genie', 'mod.ts'))
      }, Effect.provide(TestLayer)),
    )
  })

  describe('resolveImportMapsInSource', () => {
    it.effect(
      'transforms import statements with # specifiers',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { foo } from '#lib/mod.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(`import { foo } from '${tempDir}/src/lib/mod.ts'`)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'transforms export statements with # specifiers',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `export { foo } from '#lib/mod.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(`export { foo } from '${tempDir}/src/lib/mod.ts'`)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'handles multiple imports',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { foo } from '#lib/foo.ts'
import { bar } from '#lib/bar.ts'
import { baz } from './local.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toContain(`from '${tempDir}/src/lib/foo.ts'`)
        expect(result).toContain(`from '${tempDir}/src/lib/bar.ts'`)
        expect(result).toContain(`from './local.ts'`)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'preserves non-# imports unchanged',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { Effect } from 'effect'
import { foo } from './local.ts'
import { bar } from '../parent.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(sourceCode)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns source unchanged when no package.json found',
      Effect.fnUntraced(function* () {
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { foo } from '#lib/mod.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(sourceCode)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'returns source unchanged when no imports field in package.json',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(packageJsonPath, toJson({ name: 'test' }))
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { foo } from '#lib/mod.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(sourceCode)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'handles double-quoted imports',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { foo } from "#lib/mod.ts"`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(`import { foo } from "${tempDir}/src/lib/mod.ts"`)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'handles type imports',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import type { Foo } from '#lib/types.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(`import type { Foo } from '${tempDir}/src/lib/types.ts'`)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'handles re-exports',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `export * from '#lib/mod.ts'`
        const result = yield* resolveImportMapsInSource({ sourceCode, sourcePath: filePath })

        expect(result).toBe(`export * from '${tempDir}/src/lib/mod.ts'`)
      }, Effect.provide(TestLayer)),
    )

    it.effect(
      'resolves relative imports to file URLs when requested',
      Effect.fnUntraced(function* () {
        const packageJsonPath = path.join(tempDir, 'package.json')
        yield* writeFile(
          packageJsonPath,
          toJson({
            imports: { '#lib/*': './src/lib/*' },
          }),
        )
        const filePath = path.join(tempDir, 'src', 'file.ts')
        yield* writeFile(filePath, '')

        const sourceCode = `import { foo } from '#lib/mod.ts'\nimport { bar } from './local.ts'`
        const result = yield* resolveImportMapsInSource({
          sourceCode,
          sourcePath: filePath,
          resolveRelativeImports: true,
        })

        expect(result).toContain(
          `from '${pathToFileURL(path.join(tempDir, 'src', 'lib', 'mod.ts')).href}'`,
        )
        expect(result).toContain(
          `from '${pathToFileURL(path.join(tempDir, 'src', 'local.ts')).href}'`,
        )
      }, Effect.provide(TestLayer)),
    )
  })
})
