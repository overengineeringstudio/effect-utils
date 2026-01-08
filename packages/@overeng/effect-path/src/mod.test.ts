import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Either, Schema } from 'effect'
import { expect } from 'vitest'

import {
  EffectPath,
  type AbsoluteDirPath,
  type AbsoluteFilePath,
  type RelativeDirPath,
  type RelativeFilePath,
} from './mod.ts'

// =============================================================================
// Convention-Based Parsing Tests
// =============================================================================

describe('convention parsing', () => {
  describe('absoluteFile', () => {
    it.effect('parses absolute file path (Unix)', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFile('/home/user/file.txt')
        expect(result).toBe('/home/user/file.txt')
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    it.effect('fails on relative path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention
          .absoluteFile('relative/path.txt')
          .pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    it.effect('fails on directory path (trailing slash)', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention
          .absoluteFile('/path/to/dir/')
          .pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  describe('absoluteDir', () => {
    it.effect('parses absolute directory path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteDir('/home/user/')
        expect(result).toBe('/home/user/')
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    it.effect('fails on file path (no trailing slash)', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteDir('/path/to/file').pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  describe('relativeFile', () => {
    it.effect('parses relative file path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.relativeFile('src/mod.ts')
        expect(result).toBe('src/mod.ts')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  describe('relativeDir', () => {
    it.effect('parses relative directory path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.relativeDir('src/components/')
        expect(result).toBe('src/components/')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  describe('absoluteFileInfo', () => {
    it.effect('parses absolute file path and returns PathInfo', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFileInfo('/home/user/file.txt')
        expect(result.normalized).toBe('/home/user/file.txt')
        expect(result.baseName).toBe('file')
        expect(result.extension).toBe('txt')
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    it.effect('parses file with multiple extensions', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFileInfo('/path/to/archive.tar.gz')
        expect(result.baseName).toBe('archive')
        expect(result.extension).toBe('gz')
        expect(result.fullExtension).toBe('tar.gz')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  describe('absoluteDirInfo', () => {
    it.effect('parses absolute directory path and returns PathInfo', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteDirInfo('/home/user/')
        expect(result.normalized).toBe('/home/user/')
        expect(result.baseName).toBe('user')
        expect(result.extension).toBeUndefined()
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })
})

// =============================================================================
// Unsafe Constructor Tests
// =============================================================================

describe('unsafe constructors', () => {
  it('absoluteFile creates branded type', () => {
    const path: AbsoluteFilePath = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
    expect(path).toBe('/home/user/file.txt')
  })

  it('absoluteDir creates branded type with trailing slash', () => {
    const path: AbsoluteDirPath = EffectPath.unsafe.absoluteDir('/home/user/')
    expect(path).toBe('/home/user/')
  })

  it('absoluteDir adds trailing slash if missing', () => {
    const path: AbsoluteDirPath = EffectPath.unsafe.absoluteDir('/home/user')
    expect(path).toBe('/home/user/')
  })

  it('relativeFile creates branded type', () => {
    const path: RelativeFilePath = EffectPath.unsafe.relativeFile('src/mod.ts')
    expect(path).toBe('src/mod.ts')
  })

  it('relativeDir creates branded type', () => {
    const path: RelativeDirPath = EffectPath.unsafe.relativeDir('src/')
    expect(path).toBe('src/')
  })
})

// =============================================================================
// Path Operations Tests
// =============================================================================

describe('path operations', () => {
  describe('join', () => {
    it('joins directory with file', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/user/')
      const file = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.ops.join(dir, file)
      expect(result).toBe('/home/user/file.txt')
    })

    it('joins multiple segments', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/')
      const seg1 = EffectPath.unsafe.relativeDir('user/')
      const seg2 = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.ops.join(dir, seg1, seg2)
      expect(result).toBe('/home/user/file.txt')
    })

    it('joins from root directory without double slashes', () => {
      const dir = EffectPath.unsafe.absoluteDir('/')
      const file = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.ops.join(dir, file)
      expect(result).toBe('/file.txt')
    })
  })

  describe('parent', () => {
    it('gets parent directory of file', () => {
      const file = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
      const dir = EffectPath.ops.parent(file)
      expect(dir).toBe('/home/user/')
    })

    it('gets parent directory of directory', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/user/')
      const parentDir = EffectPath.ops.parent(dir)
      expect(parentDir).toBe('/home/')
    })

    it('gets parent of directory directly under root', () => {
      const dir = EffectPath.unsafe.absoluteDir('/home/')
      const parentDir = EffectPath.ops.parent(dir)
      expect(parentDir).toBe('/')
    })

    it('gets parent of relative directory at root', () => {
      const dir = EffectPath.unsafe.relativeDir('foo/')
      const parentDir = EffectPath.ops.parent(dir)
      expect(parentDir).toBe('./')
    })
  })

  describe('baseName', () => {
    it('gets filename without extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/file.txt')
      expect(EffectPath.ops.baseName(file)).toBe('file')
    })

    it('gets directory name', () => {
      const dir = EffectPath.unsafe.absoluteDir('/path/to/folder/')
      expect(EffectPath.ops.baseName(dir)).toBe('folder')
    })
  })

  describe('extension', () => {
    it('gets file extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/file.txt')
      expect(EffectPath.ops.extension(file)).toBe('txt')
    })

    it('returns undefined for files without extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/Makefile')
      expect(EffectPath.ops.extension(file)).toBeUndefined()
    })
  })

  describe('fullExtension', () => {
    it('gets full extension for multi-extension files', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/archive.tar.gz')
      expect(EffectPath.ops.fullExtension(file)).toBe('tar.gz')
    })
  })

  describe('withExtension', () => {
    it('changes file extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/file.txt')
      const result = EffectPath.ops.withExtension({ path: file, extension: 'md' })
      expect(result).toBe('/path/to/file.md')
    })

    it('adds extension to file without one', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/Makefile')
      const result = EffectPath.ops.withExtension({ path: file, extension: 'bak' })
      expect(result).toBe('/path/to/Makefile.bak')
    })
  })

  describe('withBaseName', () => {
    it('changes file name preserving extension', () => {
      const file = EffectPath.unsafe.absoluteFile('/path/to/old.txt')
      const result = EffectPath.ops.withBaseName({ path: file, name: 'new' })
      expect(result).toBe('/path/to/new.txt')
    })
  })
})

// =============================================================================
// Normalization Tests
// =============================================================================

describe('normalization', () => {
  describe('lexicalPure', () => {
    it('normalizes path with . and ..', () => {
      const path = EffectPath.unsafe.absoluteFile('/home/user/../admin/./file.txt')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('/home/admin/file.txt')
    })

    it('normalizes multiple slashes', () => {
      const path = EffectPath.unsafe.absoluteFile('/home//user///file.txt')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('/home/user/file.txt')
    })

    it('preserves trailing slash for directories', () => {
      const path = EffectPath.unsafe.absoluteDir('/home/user/../admin/')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('/home/admin/')
    })

    it('handles relative paths', () => {
      const path = EffectPath.unsafe.relativeFile('src/../lib/file.ts')
      const result = EffectPath.normalize.lexicalPure(path)
      expect(result).toBe('lib/file.ts')
    })
  })

  describe('lexical (Effect-based)', () => {
    it.effect('normalizes path using platform Path service', () =>
      Effect.gen(function* () {
        const path = EffectPath.unsafe.absoluteFile('/home/user/../admin/file.txt')
        const result = yield* EffectPath.normalize.lexical(path)
        expect(result).toBe('/home/admin/file.txt')
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })
})

// =============================================================================
// Schema Tests
// =============================================================================

describe('schema', () => {
  describe('AbsoluteFilePath', () => {
    it.effect('decodes valid absolute file path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteFilePath)(
          '/home/user/file.txt',
        )
        expect(result).toBe('/home/user/file.txt')
      }),
    )

    it.effect('rejects relative path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteFilePath)(
          'relative/file.txt',
        ).pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }),
    )

    it.effect('rejects directory path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteFilePath)(
          '/path/to/dir/',
        ).pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }),
    )
  })

  describe('AbsoluteDirPath', () => {
    it.effect('decodes valid absolute directory path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteDirPath)('/home/user/')
        expect(result).toBe('/home/user/')
      }),
    )

    it.effect('rejects file path (no trailing slash)', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteDirPath)(
          '/home/user/file.txt',
        ).pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }),
    )
  })

  describe('RelativeFilePath', () => {
    it.effect('decodes valid relative file path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.RelativeFilePath)('src/mod.ts')
        expect(result).toBe('src/mod.ts')
      }),
    )
  })

  describe('RelativeDirPath', () => {
    it.effect('decodes valid relative directory path', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.RelativeDirPath)(
          'src/components/',
        )
        expect(result).toBe('src/components/')
      }),
    )
  })

  describe('AbsoluteFileInfo', () => {
    it.effect('decodes to PathInfo structure', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteFileInfo())(
          '/path/to/file.txt',
        )
        expect(result.original).toBe('/path/to/file.txt')
        expect(result.baseName).toBe('file')
        expect(result.extension).toBe('txt')
      }),
    )

    it.effect('encodes back to normalized string by default', () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(EffectPath.schema.AbsoluteFileInfo())(
          '/path/to/file.txt',
        )
        const encoded = yield* Schema.encode(EffectPath.schema.AbsoluteFileInfo())(decoded)
        expect(encoded).toBe('/path/to/file.txt')
      }),
    )
  })

  describe('RelativeFileInfo', () => {
    it.effect('uses ./ as parent for root-level relative files', () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(EffectPath.schema.RelativeFileInfo())(
          'file.txt',
        )
        expect(decoded.parent.normalized).toBe('./')
      }),
    )
  })
})

// =============================================================================
// Sandbox Tests
// =============================================================================

describe('sandbox', () => {
  const sandbox = EffectPath.sandbox(EffectPath.unsafe.absoluteDir('/home/user/'))

  describe('validate', () => {
    it('validates safe relative path', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('file.txt'))
      expect(Either.isRight(result)).toBe(true)
    })

    it('validates nested relative path', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('sub/dir/file.txt'))
      expect(Either.isRight(result)).toBe(true)
    })

    it('rejects path escaping with ..', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('../../../etc/passwd'))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe('TraversalError')
      }
    })

    it('rejects paths that escape and then re-enter', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('../safe/file.txt'))
      expect(Either.isLeft(result)).toBe(true)
    })

    it('rejects absolute paths passed as relative', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('/etc/passwd'))
      expect(Either.isLeft(result)).toBe(true)
    })

    it('allows .. that stays within sandbox', () => {
      const result = sandbox.validate(EffectPath.unsafe.relativeFile('sub/../file.txt'))
      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe('resolve', () => {
    it('resolves relative path to absolute', () => {
      const result = sandbox.resolve(EffectPath.unsafe.relativeFile('file.txt'))
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe('/home/user/file.txt')
      }
    })

    it('resolves nested path', () => {
      const result = sandbox.resolve(EffectPath.unsafe.relativeFile('sub/dir/file.txt'))
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe('/home/user/sub/dir/file.txt')
      }
    })

    it('rejects escaping path', () => {
      // Need at least 3 .. to escape /home/user/ (which is 2 levels deep)
      const result = sandbox.resolve(EffectPath.unsafe.relativeFile('../../../etc/passwd'))
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe('contains', () => {
    it('returns true for paths inside sandbox', () => {
      const inside = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
      expect(sandbox.contains(inside)).toBe(true)
    })

    it('returns true for nested paths inside sandbox', () => {
      const inside = EffectPath.unsafe.absoluteFile('/home/user/sub/dir/file.txt')
      expect(sandbox.contains(inside)).toBe(true)
    })

    it('returns false for paths outside sandbox', () => {
      const outside = EffectPath.unsafe.absoluteFile('/etc/passwd')
      expect(sandbox.contains(outside)).toBe(false)
    })

    it('returns false for sibling paths', () => {
      const sibling = EffectPath.unsafe.absoluteFile('/home/other/file.txt')
      expect(sandbox.contains(sibling)).toBe(false)
    })

    it('returns true for the root itself', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      expect(sandbox.contains(root)).toBe(true)
    })
  })
})

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('utility functions', () => {
  describe('validatePath', () => {
    it('validates path stays in sandbox', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      const path = EffectPath.unsafe.relativeFile('file.txt')
      const result = EffectPath.validatePath({ root, path })
      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe('isContained', () => {
    it('checks if absolute path is in directory', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      const inside = EffectPath.unsafe.absoluteFile('/home/user/file.txt')
      expect(EffectPath.isContained({ root, path: inside })).toBe(true)
    })

    it('returns false for paths outside', () => {
      const root = EffectPath.unsafe.absoluteDir('/home/user/')
      const outside = EffectPath.unsafe.absoluteFile('/etc/passwd')
      expect(EffectPath.isContained({ root, path: outside })).toBe(false)
    })
  })
})

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('edge cases', () => {
  describe('path validation', () => {
    it.effect('rejects empty path', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention.absoluteFile('').pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    it.effect('rejects path with null byte', () =>
      Effect.gen(function* () {
        const result = yield* EffectPath.convention
          .absoluteFile('/path/to\0file.txt')
          .pipe(Effect.either)
        expect(Either.isLeft(result)).toBe(true)
      }).pipe(Effect.provide(NodeContext.layer)),
    )
  })

  describe('root directory handling', () => {
    it('handles root directory', () => {
      const root = EffectPath.unsafe.absoluteDir('/')
      expect(root).toBe('/')
    })

    it('parent of root returns undefined', () => {
      const root = EffectPath.unsafe.absoluteDir('/')
      const parentDir = EffectPath.ops.parent(root)
      expect(parentDir).toBeUndefined()
    })
  })

  describe('hidden files', () => {
    it('handles dotfiles', () => {
      const file = EffectPath.unsafe.absoluteFile('/home/user/.bashrc')
      // Dotfiles without a second dot have no extension - .bashrc is the full filename
      expect(EffectPath.ops.baseName(file)).toBe('.bashrc')
      expect(EffectPath.ops.extension(file)).toBe(undefined)
    })

    it('handles dotfiles with extensions', () => {
      const file = EffectPath.unsafe.absoluteFile('/home/user/.config.json')
      expect(EffectPath.ops.baseName(file)).toBe('.config')
      expect(EffectPath.ops.extension(file)).toBe('json')
    })
  })
})

// =============================================================================
// Symlink Tests
// =============================================================================

describe('symlink', () => {
  it.effect('detects and reads symlinks', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()

      const target = EffectPath.unsafe.absoluteFile(`${tmp}/target.txt`)
      const link = EffectPath.unsafe.absoluteFile(`${tmp}/link.txt`)

      yield* fs.writeFileString(target, 'hello')
      yield* fs.symlink(target, link)

      expect(yield* EffectPath.symlink.is(link)).toBe(true)
      expect(yield* EffectPath.symlink.is(target)).toBe(false)

      const resolvedTarget = yield* EffectPath.symlink.readLink(link)
      expect(resolvedTarget).toBe(target)

      const chain = yield* EffectPath.symlink.chain(link)
      expect(chain).toEqual([link, target])
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
  )
})
