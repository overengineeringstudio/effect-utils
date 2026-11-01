import { describe, expect, it } from 'bun:test'

import {
  buck2TypeScriptAdmissions,
  deriveReaderDeclarationTargets,
  readerCompositionPackagePaths,
  readerDeclarationTargets,
} from './typescript-admissions.ts'

describe('reader declaration target union', () => {
  it('follows only selected roots, traverses source-backed siblings, and handles cycles', () => {
    expect(
      deriveReaderDeclarationTargets({
        roots: ['root'],
        admissions: [
          {
            packagePath: 'root',
            workspaceSiblings: [
              { packageName: 'z', packagePath: 'z', distTarget: '//z:dist' },
              { packageName: 'source', packagePath: 'source', sourceRoots: ['src'] },
            ],
          },
          {
            packagePath: 'source',
            workspaceSiblings: [
              { packageName: 'a', packagePath: 'a', distTarget: '//a:dist' },
              { packageName: 'z', packagePath: 'z', distTarget: '//z:dist' },
            ],
          },
          { packagePath: 'a' },
          {
            packagePath: 'z',
            workspaceSiblings: [{ packageName: 'root', packagePath: 'root', sourceRoots: ['src'] }],
          },
          {
            packagePath: 'unrelated',
            workspaceSiblings: [
              { packageName: 'extra', packagePath: 'extra', distTarget: '//extra:dist' },
            ],
          },
        ],
      }),
    ).toEqual(['//a:dist', '//z:dist'])
  })

  it('rejects an entry root without an authoritative composition', () => {
    expect(() => deriveReaderDeclarationTargets({ admissions: [], roots: ['missing'] })).toThrow(
      'Reader composition has no Buck admission: missing',
    )
  })

  it('unions exactly the current 24 declarations reachable from the 17 distinct reader roots', () => {
    const admissions = Object.values(buck2TypeScriptAdmissions)
    const separatelyDerived = readerCompositionPackagePaths.flatMap((root) =>
      deriveReaderDeclarationTargets({ admissions, roots: [root] }),
    )
    expect(readerDeclarationTargets).toEqual([...new Set(separatelyDerived)].toSorted())
    expect(readerCompositionPackagePaths).toHaveLength(17)
    expect(readerDeclarationTargets).toHaveLength(24)
  })
})
