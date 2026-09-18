import { describe, expect, it } from 'vitest'

import { findProducerOverlaps, type ProducerOverlapAllowance } from './producer-overlap.ts'
import type {
  AuthoritativeBuck2TypeScriptDeclaration,
  AuthoritativeBuck2TypeScriptProject,
} from './typescript-admissions.ts'

const project = {
  packagePath: 'packages/@example/widget',
  projectPath: 'packages/@example/widget',
  projectFile: 'tsconfig.json',
  typecheckTarget: '//packages/@example/widget:typecheck',
} as const satisfies AuthoritativeBuck2TypeScriptProject
const declaration = {
  ...project,
  declarationEntrypoint: 'src/mod.d.ts',
  distTarget: '//packages/@example/widget:dist',
  testTargets: [],
} as const satisfies AuthoritativeBuck2TypeScriptDeclaration

const allAllowances = [
  {
    ledgerRow: 'effect-utils/typecheck/widget',
    operation: 'typecheck',
    packagePath: project.packagePath,
  },
  {
    ledgerRow: 'effect-utils/dist/widget',
    operation: 'dist',
    packagePath: project.packagePath,
  },
] as const satisfies readonly ProducerOverlapAllowance[]

describe('Buck producer overlap guard', () => {
  it('fails an overlap outside the transitional allowlist', () => {
    expect(
      findProducerOverlaps({
        projects: [project],
        declarations: [declaration],
        allowances: [],
        devenvTaskNames: ['ts:check', 'ts:emit'],
      }),
    ).toEqual([
      {
        operation: 'typecheck',
        packagePath: project.packagePath,
        producers: ['Buck //packages/@example/widget:typecheck', 'devenv ts:check'],
      },
      {
        operation: 'dist',
        packagePath: project.packagePath,
        producers: ['Buck //packages/@example/widget:dist', 'devenv ts:emit'],
      },
    ])
  })

  it('passes known overlaps and rejects stale ledger allowances', () => {
    expect(
      findProducerOverlaps({
        projects: [project],
        declarations: [declaration],
        allowances: allAllowances,
        devenvTaskNames: ['ts:check', 'ts:emit'],
      }),
    ).toEqual([])

    expect(() =>
      findProducerOverlaps({
        projects: [project],
        declarations: [declaration],
        allowances: allAllowances,
        devenvTaskNames: [],
      }),
    ).toThrow('stale Buck producer overlap allowances')
  })
})
