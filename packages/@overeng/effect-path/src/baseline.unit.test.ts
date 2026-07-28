import { NodeContext } from '@effect/platform-node'
import { Effect, Either, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  EffectPath,
  type AbsoluteFileInfo,
  type InvalidPathError,
  type NotAbsoluteError,
  type NotRelativeError,
  type ConventionError,
  type TraversalError,
  type RelativePath,
} from './mod.ts'

const summarizeFileInfo = (info: AbsoluteFileInfo) => ({
  original: info.original,
  normalized: info.normalized,
  segments: info.segments,
  baseName: info.baseName,
  extension: info.extension,
  fullExtension: info.fullExtension,
  parent: {
    normalized: info.parent.normalized,
    segments: info.parent.segments,
    baseName: info.parent.baseName,
  },
})

const escapeNullBytes = (path: string): string => path.replaceAll('\0', '\\0')

type ConventionBaselineError =
  | InvalidPathError
  | NotAbsoluteError
  | NotRelativeError
  | ConventionError

const summarizeConventionError = (error: ConventionBaselineError) => {
  switch (error._tag) {
    case 'InvalidPathError':
      return {
        _tag: error._tag,
        message: error.message,
        path: escapeNullBytes(error.path),
        position: error.position,
        reason: error.reason,
      }
    case 'NotAbsoluteError':
      return {
        _tag: error._tag,
        message: error.message,
        path: error.path,
        suggestedAbsolute: error.suggestedAbsolute,
      }
    case 'NotRelativeError':
      return {
        _tag: error._tag,
        absolutePrefix: error.absolutePrefix,
        message: error.message,
        path: error.path,
      }
    case 'ConventionError':
      return {
        _tag: error._tag,
        expected: error.expected,
        message: error.message,
        path: error.path,
        violation: error.violation,
      }
  }
}

const summarizeTraversalError = (error: TraversalError) => ({
  _tag: error._tag,
  escapedTo: error.escapedTo,
  escapingSegments: error.escapingSegments,
  message: error.message,
  path: error.path,
  sandboxRoot: error.sandboxRoot,
})

describe('effect-path baselines (cross-major invariant)', () => {
  it('pins PathInfo schema encoded bytes and re-encoded identity', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const normalizedSchema = EffectPath.schema.AbsoluteFileInfo()
        const originalSchema = EffectPath.schema.AbsoluteFileInfo({ encodeAs: 'original' })
        const decoded = yield* Schema.decodeUnknown(normalizedSchema)('/repo//pkg/archive.tar.gz')

        return {
          decoded: summarizeFileInfo(decoded),
          encodedDefault: yield* Schema.encode(normalizedSchema)(decoded),
          encodedOriginal: yield* Schema.encode(originalSchema)(decoded),
        }
      }),
    )

    expect(result).toMatchInlineSnapshot(`
      {
        "decoded": {
          "baseName": "archive",
          "extension": "gz",
          "fullExtension": "tar.gz",
          "normalized": "/repo/pkg/archive.tar.gz",
          "original": "/repo//pkg/archive.tar.gz",
          "parent": {
            "baseName": "pkg",
            "normalized": "/repo/pkg/",
            "segments": [
              "repo",
              "pkg",
            ],
          },
          "segments": [
            "repo",
            "pkg",
            "archive.tar.gz",
          ],
        },
        "encodedDefault": "/repo/pkg/archive.tar.gz",
        "encodedOriginal": "/repo//pkg/archive.tar.gz",
      }
    `)
  })

  it('pins convention parser failure partitions', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const absoluteFileFromRelative = yield* EffectPath.convention
          .absoluteFile('relative/file.txt')
          .pipe(Effect.either)
        const relativeFileFromAbsolute = yield* EffectPath.convention
          .relativeFile('/absolute/file.txt')
          .pipe(Effect.either)
        const fileFromDirectoryConvention = yield* EffectPath.convention
          .absoluteFile('/absolute/dir/')
          .pipe(Effect.either)
        const invalidPath = yield* EffectPath.convention
          .relativeFile('bad\0path.txt')
          .pipe(Effect.either)

        const left = <A>(either: Either.Either<A, ConventionBaselineError>) => {
          if (Either.isRight(either) === true) {
            throw new Error('expected parser failure')
          }
          return either.left
        }

        return [
          left(absoluteFileFromRelative),
          left(relativeFileFromAbsolute),
          left(fileFromDirectoryConvention),
          left(invalidPath),
        ].map(summarizeConventionError)
      }).pipe(Effect.provide(NodeContext.layer)),
    )

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "_tag": "NotAbsoluteError",
          "message": "Expected absolute path",
          "path": "relative/file.txt",
          "suggestedAbsolute": undefined,
        },
        {
          "_tag": "NotRelativeError",
          "absolutePrefix": "/",
          "message": "Expected relative path",
          "path": "/absolute/file.txt",
        },
        {
          "_tag": "ConventionError",
          "expected": "file",
          "message": "File path must not end with a separator",
          "path": "/absolute/dir/",
          "violation": "trailing_slash_on_file",
        },
        {
          "_tag": "InvalidPathError",
          "message": "Path contains null byte",
          "path": "bad\\0path.txt",
          "position": 3,
          "reason": "null_byte",
        },
      ]
    `)
  })

  it('pins path operation byte output across join, normalization, and sandbox checks', () => {
    const root = EffectPath.unsafe.absoluteDir('/repo//root')
    const joined = EffectPath.ops.join(root, EffectPath.unsafe.relativeFile('src/../index.ts'))
    const normalized = EffectPath.normalize.lexicalPure(joined)
    const sandbox = EffectPath.sandbox(EffectPath.unsafe.absoluteDir('/repo/root/'))
    const allowed = sandbox.resolve(EffectPath.unsafe.relativeFile('src/../index.ts'))
    const escaped = sandbox.resolve(EffectPath.unsafe.relativeFile('../outside.ts') as RelativePath)

    expect({
      joined,
      normalized,
      allowed: Either.isRight(allowed) === true ? allowed.right : allowed.left,
      escaped:
        Either.isLeft(escaped) === true ? summarizeTraversalError(escaped.left) : escaped.right,
    }).toMatchInlineSnapshot(`
      {
        "allowed": "/repo/root/index.ts",
        "escaped": {
          "_tag": "TraversalError",
          "escapedTo": undefined,
          "escapingSegments": [
            "..",
          ],
          "message": "Path escapes sandbox root: ../outside.ts",
          "path": "../outside.ts",
          "sandboxRoot": "/repo/root/",
        },
        "joined": "/repo//root/src/../index.ts",
        "normalized": "/repo/root/index.ts",
      }
    `)
  })
})
