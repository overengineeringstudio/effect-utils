import { describe, expect, it } from 'vitest'

import type { TreeOp, TreeSyncResult } from '../../tree.ts'
import { planResultPayload } from './map.ts'
import { type PlanAction, initialPlanState, planExitCode, planReducer } from './schema.ts'

const PAGE = '00000000-0000-4000-8000-000000000001'

const tree = (ops: readonly TreeOp[]): TreeSyncResult => ({
  _tag: 'tree',
  root: 'docs',
  rootPageId: PAGE,
  rootFile: 'index.nmd',
  direction: 'local',
  plan: true,
  ops,
})

const fold = (target: string, actions: PlanAction[]) =>
  actions.reduce((state, action) => planReducer({ state, action }), initialPlanState(target))

describe('plan output mapping', () => {
  it('groups ops by op-kind into one section each, with a counts summary', () => {
    const payload = planResultPayload(
      tree([
        { _tag: 'create', relPath: 'guide/setup.nmd', title: 'Setup' },
        { _tag: 'create', relPath: 'guide/usage.nmd', title: 'Usage' },
        { _tag: 'update', relPath: 'index.nmd', pageId: PAGE },
        { _tag: 'noop', relPath: 'reference/api.nmd', pageId: PAGE },
      ]),
    )
    const titles = payload.sections.map((section) => section.title)
    expect(titles).toEqual(['create', 'update', 'noop'])
    expect(payload.sections[0]?.items).toEqual(['guide/setup.nmd', 'guide/usage.nmd'])
    expect(payload.summary).toEqual(['4 ops', '2 create', '1 update', '1 noop'])
    expect(payload.problems).toHaveLength(0)
  })

  it('a conflict op → a CRITICAL problem; a trash_blocked op → a WARNING', () => {
    const payload = planResultPayload(
      tree([
        { _tag: 'conflict', relPath: 'a.nmd', pageId: PAGE },
        { _tag: 'trash_blocked', relPath: 'b.nmd', pageId: PAGE },
      ]),
    )
    const conflict = payload.problems.find((problem) => problem.name === 'a.nmd')
    const blocked = payload.problems.find((problem) => problem.name === 'b.nmd')
    expect(conflict?.severity).toBe('critical')
    expect(blocked?.severity).toBe('warning')
    expect(payload.summary).toEqual(['2 ops', '1 trash-blocked', '1 conflict'])
  })

  it('truncates a large op group to 5 items + `more`', () => {
    const creates: TreeOp[] = Array.from({ length: 8 }, (_, i) => ({
      _tag: 'create',
      relPath: `p${i}.nmd`,
      title: `P${i}`,
    }))
    const payload = planResultPayload(tree(creates))
    expect(payload.sections[0]?.items).toHaveLength(5)
    expect(payload.sections[0]?.more).toBe(3)
  })

  it('SetResult folds to Success (exit 0); SetError folds to Error (exit 1)', () => {
    const ok = fold('docs', [
      {
        _tag: 'SetResult',
        result: planResultPayload(tree([{ _tag: 'noop', relPath: 'x.nmd', pageId: PAGE }])),
      },
    ])
    expect(ok._tag).toBe('Success')
    expect(planExitCode(ok)).toBe(0)
    const err = fold('docs', [{ _tag: 'SetError', message: 'boom' }])
    expect(err._tag).toBe('Error')
    expect(planExitCode(err)).toBe(1)
  })
})
