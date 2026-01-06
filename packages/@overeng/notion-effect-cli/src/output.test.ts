import { FileSystem, Path } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { writeSchemaToFile } from './output.ts'

/** Layer providing NodeContext for file system operations */
const TestLayer = NodeContext.layer

describe('output', () => {
  describe('writeSchemaToFile', () => {
    it.effect('should create file with read-only permissions by default', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const tempDir = yield* fs.makeTempDirectoryScoped()
        const outputPath = path.join(tempDir, 'schema.gen.ts')
        const code = '// Generated code\nexport const Test = {}'

        yield* writeSchemaToFile({ code, outputPath })

        const content = yield* fs.readFileString(outputPath)
        expect(content).toBe(code)

        const stat = yield* fs.stat(outputPath)
        // Check file is read-only (mode & 0o222 === 0 means no write bits)
        expect(stat.mode & 0o222).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    )

    it.effect('should create file with read-write permissions when writable option is true', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const tempDir = yield* fs.makeTempDirectoryScoped()
        const outputPath = path.join(tempDir, 'schema.gen.ts')
        const code = '// Generated code\nexport const Test = {}'

        yield* writeSchemaToFile({ code, outputPath, writable: true })

        const content = yield* fs.readFileString(outputPath)
        expect(content).toBe(code)

        const stat = yield* fs.stat(outputPath)
        // Check file is writable (has write bit for owner)
        expect(stat.mode & 0o200).toBe(0o200)
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    )

    it.effect('should successfully overwrite an existing read-only file', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const tempDir = yield* fs.makeTempDirectoryScoped()
        const outputPath = path.join(tempDir, 'schema.gen.ts')
        const code1 = '// Generated code v1'
        const code2 = '// Generated code v2'

        // First write - file becomes read-only
        yield* writeSchemaToFile({ code: code1, outputPath })

        // Verify file is read-only
        const stat1 = yield* fs.stat(outputPath)
        expect(stat1.mode & 0o222).toBe(0)

        // Second write - should succeed despite read-only
        yield* writeSchemaToFile({ code: code2, outputPath })

        // Verify content was updated
        const content = yield* fs.readFileString(outputPath)
        expect(content).toBe(code2)

        // Verify file is still read-only after regeneration
        const stat2 = yield* fs.stat(outputPath)
        expect(stat2.mode & 0o222).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    )

    it.effect('should create parent directories if they do not exist', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const tempDir = yield* fs.makeTempDirectoryScoped()
        const outputPath = path.join(tempDir, 'nested', 'deeply', 'schema.gen.ts')
        const code = '// Generated code'

        yield* writeSchemaToFile({ code, outputPath })

        const exists = yield* fs.exists(outputPath)
        expect(exists).toBe(true)

        const content = yield* fs.readFileString(outputPath)
        expect(content).toBe(code)
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    )

    it.effect('should handle switching from writable to read-only on regeneration', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const tempDir = yield* fs.makeTempDirectoryScoped()
        const outputPath = path.join(tempDir, 'schema.gen.ts')
        const code1 = '// Generated code v1'
        const code2 = '// Generated code v2'

        // First write with writable: true
        yield* writeSchemaToFile({ code: code1, outputPath, writable: true })

        const stat1 = yield* fs.stat(outputPath)
        expect(stat1.mode & 0o200).toBe(0o200) // writable

        // Second write with writable: false (default)
        yield* writeSchemaToFile({ code: code2, outputPath })

        const content = yield* fs.readFileString(outputPath)
        expect(content).toBe(code2)

        const stat2 = yield* fs.stat(outputPath)
        expect(stat2.mode & 0o222).toBe(0) // read-only
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    )
  })
})
