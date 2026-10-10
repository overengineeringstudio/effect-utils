import { Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { step } from './mod.ts'
import {
  childMission,
  doc,
  input,
  MissionInputSchema,
  pr,
  product,
  runId,
  t,
  templateReferences,
  templateText,
  type TextTemplate,
} from './run-values.ts'

describe('typed native interpolation', () => {
  it('interpolates typed input references without reading runtime values', () => {
    const head = input.text('head')
    const authored = t`Review the exact ${head}; do not accept head drift.`
    expect(templateText(authored)).toBe('Review the exact ${input.head}; do not accept head drift.')
    expectTypeOf<typeof authored>().toEqualTypeOf<TextTemplate>()
    expectTypeOf<typeof authored>().not.toEqualTypeOf<string>()
    expect(templateReferences(authored)[0]).toBe(head)
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
    expect(templateReferences(doc`doc/example/${runId}/acceptance`)).toEqual([])
    expect(templateReferences(childMission`example/followups/${runId}`)).toEqual([])
  })

  it('preserves ordinary literal and scalar interpolation', () => {
    expect(templateText(t`PR ${7}, ready=${true}, text=${'exact'}.`)).toBe(
      'PR 7, ready=true, text=exact.',
    )
    expect(templateText('Already native text.')).toBe('Already native text.')
    expect(templateReferences(t`No references: ${7}, ${true}, ${runId}.`)).toEqual([])
  })

  it('retains exact input and product objects in every tag despite identical text', () => {
    const declared = input.text('head')
    const foreign = input.text('head')
    const resource = input.resource({ name: 'source', kind: 'vcs.ref' })
    const report = product.resource({ kind: 'example.report', fields: { state: 'ready' } })
    const producer = step({ id: 'produce', produces: { report } })
    expect(producer.products.report).toBe(report)
    const text = t`${declared}/${resource}/${report}/${runId}/${declared}`
    const document = doc`doc/${declared}/${resource}/${report}/${runId}/${declared}`
    const child = childMission`example/${declared}/${resource}/${report}/${runId}/${declared}`
    for (const value of [text, document, child]) {
      const references = templateReferences(value)
      expect(references).toHaveLength(4)
      expect(references[0]).toBe(declared)
      expect(references[1]).toBe(resource)
      expect(references[2]).toBe(report)
      expect(references[3]).toBe(declared)
    }
    const otherText = t`${foreign}/${resource}/${report}/${runId}/${foreign}`
    expect(templateText(otherText)).toBe(templateText(text))
    expect(otherText).not.toBe(text)
    expect(templateReferences(otherText)[0]).toBe(foreign)
    expect(templateReferences(text)[0]).not.toBe(foreign)
  })

  it('retains nested template provenance rather than only its rendered text', () => {
    const head = input.text('head')
    const inner = t`exact/${head}`
    const outer = t`Review ${inner}.`
    const document = doc`doc/${inner}/${runId}`
    const child = childMission`example/${inner}/${runId}`
    expect(templateText(outer)).toBe('Review exact/${input.head}.')
    expect(document.subject).toBe('doc/exact/${input.head}/${ST_MISSION_RUN}')
    expect(child.id).toBe('example/exact/${input.head}/${ST_MISSION_RUN}')
    for (const value of [outer, document, child]) {
      expect(templateReferences(value)).toHaveLength(1)
      expect(templateReferences(value)[0]).toBe(head)
    }
    expect(templateReferences({ kind: 'template', text: inner.text })).toEqual([])
  })

  it('does not invent product ownership while interpolating an unbound handle', () => {
    const report = product.resource({ kind: 'example.report', fields: { state: 'ready' } })
    expect(() => t`${report}`).toThrow('must belong to a constructed step')
    expect(() => doc`doc/${report}`).toThrow('must belong to a constructed step')
    expect(() => childMission`example/${report}`).toThrow('must belong to a constructed step')
  })

  it.each(['a'.repeat(160), 'é'.repeat(80), '😀'.repeat(40)])(
    'accepts a native 160-byte input name %s',
    (name) => {
      expect(input.text(name).name).toBe(name)
      expect(input.resource({ name, kind: 'vcs.ref' }).name).toBe(name)
      expect(Schema.decodeSync(MissionInputSchema)({ name, kind: 'text' }).name).toBe(name)
    },
  )

  it.each(['a'.repeat(161), 'é'.repeat(81), '😀'.repeat(41), '', 'has spaces', 'a/b'])(
    'rejects an invalid or overlong input name %s',
    (name) => {
      expect(() => input.text(name)).toThrow()
      expect(() => input.resource({ name, kind: 'vcs.ref' })).toThrow()
      expect(() => Schema.decodeSync(MissionInputSchema)({ name, kind: 'text' })).toThrow()
      expect(() => Schema.decodeSync(MissionInputSchema)({ name, kind: 'resource' })).toThrow()
    },
  )

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
