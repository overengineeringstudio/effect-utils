import { describe, expect, it } from 'vitest'

import { planRootBuckAggregates, rootBuckAggregateProjection } from './root-aggregate-projection.ts'
import { authoritativeBuck2TypeScriptProjects } from './typescript-admissions.ts'

describe('root Buck aggregate projection', () => {
  it('derives quick and all from the authoritative target sets', () => {
    expect(
      planRootBuckAggregates({
        typecheckTargets: ['//packages/@example/alpha:typecheck'],
        distTargets: ['//packages/@example/alpha:dist'],
        testTargets: ['//packages/@example/alpha:test'],
      }),
    ).toEqual({
      quick: ['//packages/@example/alpha:typecheck'],
      all: [
        ':quick',
        '//packages/@example/alpha:dist',
        '//packages/@example/alpha:test',
        '//buck2/toolchains:archive_tool',
        '//buck2/toolchains:product_tool',
      ],
    })
  })

  it('renders the stack-head root targets and registry aggregates together', () => {
    const output = rootBuckAggregateProjection().stringify({ cwd: '/repo', location: '' })

    expect(output).toContain('name = "editor_view_inputs"')
    expect(output).toContain('name = "static_sources"')
    expect(output).toContain('name = "quick"')
    expect(output).toContain('name = "all"')
    expect(output).toContain('"000": "//context/effect/socket:typecheck"')
    expect(output).not.toContain('srcs = [')
  })

  it('keeps the production quick target set equal to the admission registry', () => {
    expect(planRootBuckAggregates().quick).toEqual(
      authoritativeBuck2TypeScriptProjects.map((project) => project.typecheckTarget),
    )
  })
})
