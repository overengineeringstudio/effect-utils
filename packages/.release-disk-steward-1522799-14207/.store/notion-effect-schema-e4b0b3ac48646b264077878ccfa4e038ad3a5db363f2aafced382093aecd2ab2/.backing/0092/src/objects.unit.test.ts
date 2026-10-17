import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { PageParent } from './objects.ts'

const decode = Schema.decodeUnknownSync(PageParent)
const uuid = '01234567-89ab-cdef-0123-456789abcdef'

describe('Notion.PageParent', () => {
  it('decodes the modeled parent types', () => {
    expect(decode({ type: 'page_id', page_id: uuid })).toEqual({ type: 'page_id', page_id: uuid })
    expect(decode({ type: 'workspace', workspace: true })).toEqual({
      type: 'workspace',
      workspace: true,
    })
  })

  it('decodes agent_id parents (Custom Agent instruction pages)', () => {
    expect(decode({ type: 'agent_id', agent_id: uuid })).toEqual({
      type: 'agent_id',
      agent_id: uuid,
    })
  })

  it('rejects an unmodeled parent type rather than silently degrading', () => {
    expect(() => decode({ type: 'something_new', something_new: uuid })).toThrow()
  })
})
