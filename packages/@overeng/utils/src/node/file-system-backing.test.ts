import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSystem, Path } from '@effect/platform'
import { describe, it } from '@effect/vitest'
import { Duration, Effect, Layer } from 'effect'
import { DistributedSemaphoreBacking } from 'effect-distributed-lock'
import { expect } from 'vitest'
import * as FileSystemBacking from './file-system-backing.ts'

/**
 * Minimal FileSystem layer using Node.js native fs module directly.
 * This avoids importing @effect/platform-node which has transitive
 * dependency issues with @effect/rpc.
 */
const makeNodeFsLayer = (): Layer.Layer<FileSystem.FileSystem | Path.Path> => {
  const nodeFs = {
    access: () => Effect.void,
    chmod: () => Effect.void,
    chown: () => Effect.void,
    copy: () => Effect.void,
    copyFile: () => Effect.void,
    exists: (filePath: string) => Effect.sync(() => fs.existsSync(filePath)),
    link: () => Effect.void,
    makeDirectory: (dirPath: string, options?: { recursive?: boolean }) =>
      Effect.sync(() => {
        fs.mkdirSync(dirPath, { recursive: options?.recursive ?? false })
      }),
    makeTempDirectory: (options?: { prefix?: string }) =>
      Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), options?.prefix ?? 'effect-'))),
    makeTempDirectoryScoped: () => Effect.die('not implemented'),
    makeTempFile: () => Effect.die('not implemented'),
    makeTempFileScoped: () => Effect.die('not implemented'),
    open: () => Effect.die('not implemented'),
    readDirectory: (dirPath: string) => Effect.sync(() => fs.readdirSync(dirPath)),
    readFile: (filePath: string) => Effect.sync(() => new Uint8Array(fs.readFileSync(filePath))),
    readFileString: (filePath: string) => Effect.sync(() => fs.readFileSync(filePath, 'utf-8')),
    readLink: () => Effect.die('not implemented'),
    realPath: () => Effect.die('not implemented'),
    remove: (filePath: string) =>
      Effect.sync(() => fs.rmSync(filePath, { recursive: true, force: true })),
    rename: (oldPath: string, newPath: string) => Effect.sync(() => fs.renameSync(oldPath, newPath)),
    sink: () => Effect.die('not implemented'),
    stat: () => Effect.die('not implemented'),
    stream: () => Effect.die('not implemented'),
    symlink: () => Effect.void,
    truncate: () => Effect.void,
    utimes: () => Effect.void,
    watch: () => Effect.die('not implemented'),
    writeFile: () => Effect.void,
    writeFileString: (filePath: string, content: string) =>
      Effect.sync(() => fs.writeFileSync(filePath, content)),
  } as FileSystem.FileSystem

  const nodePath = {
    [Path.TypeId]: Path.TypeId,
    basename: (filePath: string, suffix?: string) => path.basename(filePath, suffix),
    dirname: (filePath: string) => path.dirname(filePath),
    extname: (filePath: string) => path.extname(filePath),
    fromFileUrl: (url: URL) => Effect.sync(() => new URL(url).pathname),
    isAbsolute: (filePath: string) => path.isAbsolute(filePath),
    join: (...paths: string[]) => path.join(...paths),
    normalize: (filePath: string) => path.normalize(filePath),
    parse: (filePath: string) => path.parse(filePath),
    relative: (from: string, to: string) => path.relative(from, to),
    resolve: (...paths: string[]) => path.resolve(...paths),
    sep: path.sep,
    toFileUrl: (filePath: string) => Effect.sync(() => new URL(`file://${filePath}`)),
    toNamespacedPath: (filePath: string) => filePath,
    format: (pathObject: Partial<path.ParsedPath>) => path.format(pathObject),
  } as Path.Path

  return Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, nodeFs),
    Layer.succeed(Path.Path, nodePath),
  )
}

const TestLayer = makeNodeFsLayer()

describe('FileSystemBacking', () => {
  describe('tryAcquire', () => {
    it.effect('acquires permits when available', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            3,
            1,
          )

          expect(acquired).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('respects permit limit', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const acquired1 = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            2,
            2,
          )
          expect(acquired1).toBe(true)

          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            2,
            1,
          )
          expect(acquired2).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('multiple holders can acquire permits up to limit', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Limit is 3, acquire 1 permit each from 3 holders
          const acquired1 = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            3,
            1,
          )
          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            3,
            1,
          )
          const acquired3 = yield* backing.tryAcquire(
            'test-key',
            'holder-3',
            Duration.seconds(30),
            3,
            1,
          )
          // 4th holder should fail
          const acquired4 = yield* backing.tryAcquire(
            'test-key',
            'holder-4',
            Duration.seconds(30),
            3,
            1,
          )

          expect(acquired1).toBe(true)
          expect(acquired2).toBe(true)
          expect(acquired3).toBe(true)
          expect(acquired4).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('same holder can re-acquire (update permits)', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Acquire 1 permit
          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 1)

          // Re-acquire with 2 permits (should succeed, updates existing)
          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            2,
            2,
          )
          expect(acquired).toBe(true)

          // Verify count is 2, not 3
          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(2)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('different keys are independent', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Acquire all permits on key-1
          yield* backing.tryAcquire('key-1', 'holder-1', Duration.seconds(30), 1, 1)

          // Should still be able to acquire on key-2
          const acquired = yield* backing.tryAcquire(
            'key-2',
            'holder-1',
            Duration.seconds(30),
            1,
            1,
          )
          expect(acquired).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('release', () => {
    it.effect('releases held permits', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 2)

          const released = yield* backing.release('test-key', 'holder-1', 2)
          expect(released).toBe(2)

          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            2,
            2,
          )
          expect(acquired).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('partial release keeps remaining permits', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 3, 3)

          // Release only 1 permit
          const released = yield* backing.release('test-key', 'holder-1', 1)
          expect(released).toBe(1)

          // Should have 2 permits remaining
          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(2)

          // Another holder can acquire 1 permit
          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            3,
            1,
          )
          expect(acquired).toBe(true)

          // But not 2 permits
          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-3',
            Duration.seconds(30),
            3,
            2,
          )
          expect(acquired2).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('releasing more than held returns actual released count', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 5, 2)

          // Try to release 5 but only have 2
          const released = yield* backing.release('test-key', 'holder-1', 5)
          expect(released).toBe(2)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('releasing from nonexistent holder returns 0', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const released = yield* backing.release('test-key', 'nonexistent', 1)
          expect(released).toBe(0)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('refresh', () => {
    it.effect('refreshes TTL for held permits', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 1)

          const refreshed = yield* backing.refresh(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            2,
            1,
          )
          expect(refreshed).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('returns false when permits expired', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const refreshed = yield* backing.refresh(
            'test-key',
            'nonexistent-holder',
            Duration.seconds(30),
            2,
            1,
          )
          expect(refreshed).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('getCount', () => {
    it.effect('returns count of held permits', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 5, 3)

          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(3)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('excludes expired permits from count', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tempDir = yield* fs.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.millis(50), 5, 3)

          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))

          const count = yield* backing.getCount('test-key', Duration.millis(50))
          expect(count).toBe(0)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('counts permits from multiple holders', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 10, 2)
          yield* backing.tryAcquire('test-key', 'holder-2', Duration.seconds(30), 10, 3)
          yield* backing.tryAcquire('test-key', 'holder-3', Duration.seconds(30), 10, 1)

          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(6) // 2 + 3 + 1
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('file structure', () => {
    it.effect('creates separate lock files per holder', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('my-key', 'holder-a', Duration.seconds(30), 5, 2)
          yield* backing.tryAcquire('my-key', 'holder-b', Duration.seconds(30), 5, 1)

          // Verify directory structure
          const keyDir = `${lockDir}/my-key`
          const entries = fs.readdirSync(keyDir).sort()

          expect(entries).toEqual(['holder-a.lock', 'holder-b.lock'])

          // Verify lock file content
          const holderAContent = JSON.parse(fs.readFileSync(`${keyDir}/holder-a.lock`, 'utf-8'))
          expect(holderAContent.permits).toBe(2)
          expect(typeof holderAContent.expiresAt).toBe('number')

          const holderBContent = JSON.parse(fs.readFileSync(`${keyDir}/holder-b.lock`, 'utf-8'))
          expect(holderBContent.permits).toBe(1)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('removes lock file on full release', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('my-key', 'holder-a', Duration.seconds(30), 5, 2)

          // Verify file exists
          const keyDir = `${lockDir}/my-key`
          expect(fs.existsSync(`${keyDir}/holder-a.lock`)).toBe(true)

          // Release all permits
          yield* backing.release('my-key', 'holder-a', 2)

          // Verify file is removed
          expect(fs.existsSync(`${keyDir}/holder-a.lock`)).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
