import { describe, expect, it } from 'vitest'

import { childMission, doc, input, pr, runId, t } from './run-values.ts'

describe('typed native interpolation', () => {
  it('interpolates typed input references without reading runtime values', () => {
    const head = input.text('head')
    expect(t`Review the exact ${head}; do not accept head drift.`).toBe(
      'Review the exact ${input.head}; do not accept head drift.',
    )
  })

  it('retains native run-context interpolation in document and child references', () => {
    expect(doc`doc/example/${runId}/acceptance`).toEqual({
      kind: 'document',
      subject: 'doc/example/${ST_MISSION_RUN}/acceptance',
    })
    expect(childMission`example/followups/${runId}`).toEqual({
      kind: 'child-mission',
      id: 'example/followups/${ST_MISSION_RUN}',
    })
  })

  it('preserves ordinary literal and scalar interpolation', () => {
    expect(t`PR ${7}, ready=${true}, text=${'exact'}.`).toBe('PR 7, ready=true, text=exact.')
  })

  it('constructs a typed pull request without conflating it with an input or person', () => {
    expect(pr('example/repository', 7)).toEqual({
      kind: 'pull-request',
      repo: 'example/repository',
      number: 7,
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PR number %s', (number) => {
    expect(() => pr('example/repository', number)).toThrow()
  })

  it.each(['repository', '/repository', 'owner/', 'owner/repository/extra', 'owner/repo name'])(
    'rejects invalid repository %s',
    (repo) => {
      expect(() => pr(repo, 7)).toThrow()
    },
  )
})
