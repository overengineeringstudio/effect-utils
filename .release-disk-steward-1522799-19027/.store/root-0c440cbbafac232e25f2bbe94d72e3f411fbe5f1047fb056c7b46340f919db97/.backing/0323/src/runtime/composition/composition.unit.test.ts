import { describe, expect, it } from 'vitest'

import type { WorkspacePackageLike } from '../package-json/mod.ts'
import { isTsconfigReferenceTarget, tsconfigReferencesFromPackages } from './mod.ts'

const pkg = ({
  repoName = 'repo',
  name,
  memberPath,
  deps = [],
}: {
  repoName?: string
  name: string
  memberPath: string
  deps?: readonly WorkspacePackageLike[]
}): WorkspacePackageLike => ({
  data: { name },
  meta: {
    workspace: {
      repoName,
      memberPath,
      deps,
    },
  },
})

describe('tsconfigReferencesFromPackages', () => {
  it('projects sorted direct references from package workspace deps', () => {
    const utils = pkg({ name: '@test/utils', memberPath: 'packages/utils' })
    const core = pkg({ name: '@test/core', memberPath: 'packages/core' })
    const app = pkg({
      name: '@test/app',
      memberPath: 'packages/app',
      deps: [utils, core],
    })

    expect(tsconfigReferencesFromPackages({ from: app })).toEqual([
      { path: '../core' },
      { path: '../utils' },
    ])
  })

  it('projects foreign-repo dependencies through the composed repos path', () => {
    const shared = pkg({
      repoName: 'shared-repo',
      name: '@shared/core',
      memberPath: 'packages/core',
    })
    const app = pkg({
      name: '@test/app',
      memberPath: 'packages/app',
      deps: [shared],
    })

    expect(tsconfigReferencesFromPackages({ from: app })).toEqual([
      { path: '../../repos/shared-repo/packages/core' },
    ])
  })

  it('deduplicates explicit packages after path projection', () => {
    const utils = pkg({ name: '@test/utils', memberPath: 'packages/utils' })
    const app = pkg({ name: '@test/app', memberPath: 'packages/app' })

    expect(tsconfigReferencesFromPackages({ from: app, packages: [utils, utils] })).toEqual([
      { path: '../utils' },
    ])
  })

  it('skips packages with supplied ineligible tsconfig data', () => {
    const buildable = pkg({ name: '@test/buildable', memberPath: 'packages/buildable' })
    const noEmit = pkg({ name: '@test/no-emit', memberPath: 'packages/no-emit' })
    const nonComposite = pkg({
      name: '@test/non-composite',
      memberPath: 'packages/non-composite',
    })
    const app = pkg({ name: '@test/app', memberPath: 'packages/app' })

    expect(
      tsconfigReferencesFromPackages({
        from: app,
        packages: [
          { package: noEmit, tsconfig: { compilerOptions: { composite: true, noEmit: true } } },
          { package: nonComposite, tsconfig: { compilerOptions: { composite: false } } },
          { package: buildable, tsconfig: { compilerOptions: { composite: true } } },
        ],
      }),
    ).toEqual([{ path: '../buildable' }])
  })

  it('supports project-local include predicates', () => {
    const app = pkg({ name: '@test/app', memberPath: 'packages/app' })
    const generated = pkg({ name: '@test/generated', memberPath: 'packages/generated' })
    const runtime = pkg({ name: '@test/runtime', memberPath: 'packages/runtime' })

    expect(
      tsconfigReferencesFromPackages({
        from: app,
        packages: [generated, runtime],
        include: (entry) => entry.data.name !== '@test/generated',
      }),
    ).toEqual([{ path: '../runtime' }])
  })
})

describe('isTsconfigReferenceTarget', () => {
  it('accepts default and composite configs', () => {
    expect(isTsconfigReferenceTarget({})).toBe(true)
    expect(isTsconfigReferenceTarget({ compilerOptions: { composite: true } })).toBe(true)
  })

  it('rejects explicit TypeScript project-reference opt-outs', () => {
    expect(isTsconfigReferenceTarget({ compilerOptions: { composite: false } })).toBe(false)
    expect(isTsconfigReferenceTarget({ compilerOptions: { noEmit: true } })).toBe(false)
  })
})
