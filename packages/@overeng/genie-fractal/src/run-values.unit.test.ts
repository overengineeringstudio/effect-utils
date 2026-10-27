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
  utf8ByteLength,
} from './run-values.ts'

describe('immutable run-value snapshots', () => {
  it('makes text input declarations immutable without changing reference identity', () => {
    const head = input.text('head')
    const text = t`${head}`
    expect(Object.isFrozen(head)).toBe(true)
    expect(Reflect.set(head, 'name', 'other')).toBe(false)
    expect(Reflect.set(head, 'kind', 'resource')).toBe(false)
    expect(head.name).toBe('head')
    expect(head.kind).toBe('text')
    expect(templateReferences(text)[0]).toBe(head)
    expect(templateText(t`${head}`)).toBe('${input.head}')
  })

  it('snapshots resource input options without freezing the caller', () => {
    const options = { name: 'source', kind: 'vcs.ref' }
    const source = input.resource(options)
    options.name = 'other'
    options.kind = 'other.kind'
    expect(Object.isFrozen(options)).toBe(false)
    expect(Object.isFrozen(source)).toBe(true)
    expect(Reflect.set(source, 'name', 'changed')).toBe(false)
    expect(Reflect.set(source, 'resourceKind', 'changed')).toBe(false)
    expect(source.name).toBe('source')
    expect(source.kind).toBe('resource')
    expect(source.resourceKind).toBe('vcs.ref')
    expect(templateReferences(t`${source}`)[0]).toBe(source)
  })

  it('copies and freezes field product constraints while retaining template identity', () => {
    const head = input.text('head')
    const label = t`exact/${head}`
    const callerTemplate: TextTemplate = { kind: 'template', text: 'caller-owned' }
    const fields = { state: 'ready', label, callerTemplate }
    const options = { subject: 'message/report' as `message/${string}`, fields }
    const report = product.field(options)
    fields.state = 'changed'
    fields.label = t`replacement`
    options.subject = 'message/other'
    expect(Object.isFrozen(options)).toBe(false)
    expect(Object.isFrozen(fields)).toBe(false)
    expect(Object.isFrozen(callerTemplate)).toBe(false)
    expect(report.subject).toBe('message/report')
    expect(report.fields).not.toBe(fields)
    expect(report.fields.state).toBe('ready')
    expect(report.fields.label).toBe(label)
    expect(report.fields.callerTemplate).toBe(callerTemplate)
    expect(templateReferences(report.fields.label)[0]).toBe(head)
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.fields)).toBe(true)
    expect(Reflect.set(report, 'subject', 'message/changed')).toBe(false)
    expect(Reflect.set(report.fields, 'state', 'changed')).toBe(false)
    expect(Reflect.set(report.fields, 'added', true)).toBe(false)
  })

  it('copies and freezes resource product constraints while retaining template identity', () => {
    const head = input.text('head')
    const label = t`exact/${head}`
    const callerTemplate: TextTemplate = { kind: 'template', text: 'caller-owned' }
    const fields = { state: 'ready', label, callerTemplate, kind: 'overridden' }
    const options = {
      kind: 'example.report',
      subject: 'resource/report' as `resource/${string}`,
      fields,
    }
    const report = product.resource(options)
    fields.state = 'changed'
    fields.label = t`replacement`
    fields.kind = 'changed'
    options.kind = 'other.kind'
    options.subject = 'resource/other'
    expect(Object.isFrozen(options)).toBe(false)
    expect(Object.isFrozen(fields)).toBe(false)
    expect(Object.isFrozen(callerTemplate)).toBe(false)
    expect(report.subject).toBe('resource/report')
    expect(report.fields).not.toBe(fields)
    expect(report.fields.state).toBe('ready')
    expect(report.fields.kind).toBe('example.report')
    expect(report.fields.label).toBe(label)
    expect(report.fields.callerTemplate).toBe(callerTemplate)
    expect(templateReferences(report.fields.label)[0]).toBe(head)
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.fields)).toBe(true)
    expect(Reflect.set(report, 'subject', 'resource/changed')).toBe(false)
    expect(Reflect.set(report.fields, 'state', 'changed')).toBe(false)
    expect(Reflect.set(report.fields, 'added', true)).toBe(false)
  })

  it('keeps tag results and their exposed provenance immutable', () => {
    const head = input.text('head')
    const other = input.text('other')
    const text = t`exact/${head}`
    const document = doc`doc/${text}`
    const child = childMission`example/${text}`
    for (const value of [text, document, child]) {
      expect(Object.isFrozen(value)).toBe(true)
      expect(Reflect.set(value, 'kind', 'changed')).toBe(false)
      const references = templateReferences(value)
      expect(Object.isFrozen(references)).toBe(true)
      expect(Reflect.set(references, '0', other)).toBe(false)
      expect(Reflect.set(references, 'length', 0)).toBe(false)
      expect(references).toHaveLength(1)
      expect(references[0]).toBe(head)
    }
    expect(Reflect.set(text, 'text', 'changed')).toBe(false)
    expect(Reflect.set(document, 'subject', 'doc/changed')).toBe(false)
    expect(Reflect.set(child, 'id', 'changed')).toBe(false)
    expect(templateText(text)).toBe('exact/${input.head}')
    expect(document.subject).toBe('doc/exact/${input.head}')
    expect(child.id).toBe('example/exact/${input.head}')
    const emptyReferences = templateReferences({})
    expect(Object.isFrozen(emptyReferences)).toBe(true)
    expect(Reflect.set(emptyReferences, '0', other)).toBe(false)
    expect(templateReferences({})).toEqual([])
  })

  it('snapshots pull request options without freezing the caller', () => {
    const options = { repo: 'example/repository', number: 7 }
    const target = pr(options)
    options.repo = 'other/repository'
    options.number = 8
    expect(Object.isFrozen(options)).toBe(false)
    expect(Object.isFrozen(target)).toBe(true)
    expect(Reflect.set(target, 'repo', 'changed/repository')).toBe(false)
    expect(Reflect.set(target, 'number', 9)).toBe(false)
    expect(target).toEqual({ kind: 'pull-request', repo: 'example/repository', number: 7 })
  })

  it('keeps the shared run context immutable', () => {
    expect(Object.isFrozen(runId)).toBe(true)
    expect(Reflect.set(runId, 'name', 'OTHER')).toBe(false)
    expect(templateText(t`${runId}`)).toBe('${ST_MISSION_RUN}')
  })
})

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

  it.each(['', 'a', 'é', '€', '😀', '\ud800', '\udfff', '\ud800a', 'a\udfff', '😀é€a'])(
    'counts platform-neutral UTF-8 bytes for %j',
    (value) => {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).length)
    },
  )

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
    expect(pr({ repo: 'example/repository', number: 7 })).toEqual({
      kind: 'pull-request',
      repo: 'example/repository',
      number: 7,
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PR number %s', (number) => {
    expect(() => pr({ repo: 'example/repository', number })).toThrow()
  })

  it.each(['repository', '/repository', 'owner/', 'owner/repository/extra', 'owner/repo name'])(
    'rejects invalid repository %s',
    (repo) => {
      expect(() => pr({ repo, number: 7 })).toThrow()
    },
  )
})
