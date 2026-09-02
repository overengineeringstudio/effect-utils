import { describe, expect, it } from 'vitest'

import {
  buckOwnedFilesReportPasses,
  buckOwnedFilesSchema,
  makeBuckOwnedFilesReport,
  parseBuckOwnershipQuery,
  parseGitCandidatePaths,
  renderBuckOwnedFilesReport,
  requireRepositoryRelativePath,
} from './owned-files.ts'

describe('buck-owned-files/v1', () => {
  it('renders deterministic paths and owners independent of query order', () => {
    const first = makeBuckOwnedFilesReport({
      candidates: ['packages/z/src/z.ts', 'packages/a/src/a.ts'],
      ownersByPath: new Map([
        ['packages/z/src/z.ts', ['root//packages/z:z', 'root//packages/z:all']],
        ['packages/a/src/a.ts', ['root//packages/a:a']],
      ]),
    })
    const second = makeBuckOwnedFilesReport({
      candidates: ['packages/a/src/a.ts', 'packages/z/src/z.ts'],
      ownersByPath: new Map([
        ['packages/a/src/a.ts', ['root//packages/a:a']],
        ['packages/z/src/z.ts', ['root//packages/z:all', 'root//packages/z:z']],
      ]),
    })

    expect(renderBuckOwnedFilesReport(first)).toBe(renderBuckOwnedFilesReport(second))
    expect(first.files.map((file) => file.path)).toEqual([
      'packages/a/src/a.ts',
      'packages/z/src/z.ts',
    ])
    expect(first.files[1]?.owners).toEqual(['root//packages/z:all', 'root//packages/z:z'])
  })

  it('classifies zero, one, and many owners and passes only exact ownership', () => {
    const report = makeBuckOwnedFilesReport({
      candidates: ['src/many.ts', 'src/one.ts', 'src/zero.ts'],
      ownersByPath: new Map([
        ['src/many.ts', ['root//src:all', 'root//src:many']],
        ['src/one.ts', ['root//src:one']],
        ['src/zero.ts', []],
      ]),
    })

    expect(report.files.map(({ path, ownership }) => [path, ownership])).toEqual([
      ['src/many.ts', 'multiply-owned'],
      ['src/one.ts', 'owned'],
      ['src/zero.ts', 'unowned'],
    ])
    expect(buckOwnedFilesReportPasses(report)).toBe(false)
    expect(
      buckOwnedFilesReportPasses(
        makeBuckOwnedFilesReport({
          candidates: ['src/one.ts'],
          ownersByPath: new Map([['src/one.ts', ['root//src:one']]]),
        }),
      ),
    ).toBe(true)
  })

  it.each([
    '',
    '/absolute.ts',
    'C:/absolute.ts',
    '../escape.ts',
    'src/../escape.ts',
    'src/./file.ts',
    'src//file.ts',
    'src\\file.ts',
    'src/file.ts\nnext.ts',
  ])('rejects malformed or escaping repository path %j', (path) => {
    expect(() => requireRepositoryRelativePath(path)).toThrow(
      'path must be a normalized portable repository-relative path',
    )
  })

  it('decodes only strict NUL-delimited Git paths and grouped Buck ownership', () => {
    const candidates = parseGitCandidatePaths(Buffer.from('src/z.ts\0src/a.ts\0'))
    expect(candidates).toEqual(['src/a.ts', 'src/z.ts'])
    expect(() => parseGitCandidatePaths(Buffer.from('../escape.ts\0'))).toThrow(
      'path must be a normalized portable repository-relative path',
    )
    expect(() => parseGitCandidatePaths(Buffer.from('src/a.ts\n'))).toThrow(
      'Git candidate output is not NUL terminated',
    )

    const owners = parseBuckOwnershipQuery({
      candidates,
      stdout: Buffer.from(
        JSON.stringify({
          'src/z.ts': ['root//src:z', 'root//src:all'],
          'src/a.ts': [],
        }),
      ),
    })
    expect([...owners]).toEqual([
      ['src/a.ts', []],
      ['src/z.ts', ['root//src:all', 'root//src:z']],
    ])
    expect(() =>
      parseBuckOwnershipQuery({
        candidates,
        stdout: Buffer.from(JSON.stringify({ 'src/a.ts': [], '../escape.ts': [] })),
      }),
    ).toThrow('path must be a normalized portable repository-relative path')
  })

  it('preserves the exact minimal report schema contract', () => {
    const report = makeBuckOwnedFilesReport({
      candidates: ['src/file.ts'],
      ownersByPath: new Map([['src/file.ts', ['root//src:file']]]),
    })

    expect(buckOwnedFilesSchema).toBe('buck-owned-files/v1')
    expect(report).toEqual({
      schema: 'buck-owned-files/v1',
      files: [
        {
          path: 'src/file.ts',
          ownership: 'owned',
          owners: ['root//src:file'],
        },
      ],
    })
    expect(renderBuckOwnedFilesReport(report)).toBe(`${JSON.stringify(report, null, 2)}\n`)
  })
})
