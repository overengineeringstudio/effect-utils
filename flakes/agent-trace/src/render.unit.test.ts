import { describe, expect, it } from 'vitest'

import { renderFooterHuman, renderTrailerHuman, summaryText } from './render.ts'

const sparse = ({
  who = {},
  why = {},
  how = {},
}: { who?: object; why?: object; how?: object } = {}) => ({ type: 'agent-trace/v2', who, why, how })

describe('sparse attribution summaries', () => {
  it('preserves accountable-human wording only when a principal was observed', () => {
    const view = sparse({
      who: { principal: 'github:johannes', agent: 'agent/dotfiles/disk-steward-dev3' },
      why: {
        mission: { name: 'dotfiles/disk-steward-dev3/daily-health' },
        step: { name: 'inspect' },
      },
    })
    expect(summaryText(view)).toBe(
      '@johannes via dotfiles/disk-steward-dev3 · daily-health › inspect',
    )
    expect(renderTrailerHuman(view)).toBe(
      'On-Behalf-Of: @johannes via dotfiles/disk-steward-dev3 · daily-health › inspect',
    )
    expect(renderFooterHuman({ view, audience: 'public-minimal' })).toContain(
      '<summary>Posted on behalf of @johannes via dotfiles/disk-steward-dev3 · daily-health › inspect</summary>',
    )
  })
  it('does not leave a dangling via or imply an absent principal on either surface', () => {
    const view = sparse({ who: { agent: 'agent/dotfiles/disk-steward-dev3' } })
    expect(summaryText(view)).toBe('dotfiles/disk-steward-dev3')
    expect(renderTrailerHuman(view)).toBe('Agent: dotfiles/disk-steward-dev3')
    for (const audience of ['public-minimal', 'private-rich'] as const)
      expect(renderFooterHuman({ view, audience })).toContain(
        '<summary>Posted by dotfiles/disk-steward-dev3</summary>',
      )
    expect(
      summaryText(sparse({ who: { agent: 'direct.01234567' }, how: { harness: { tool: 'OMP' } } })),
    ).toBe('direct session · OMP')
  })
  it('joins only observed context without leading separators', () => {
    for (const [view, expected] of [
      [sparse({ how: { harness: { tool: 'OMP' } } }), 'OMP'],
      [
        sparse({ why: { mission: { name: 'daily-health' }, step: { name: 'inspect' } } }),
        'daily-health › inspect',
      ],
      [sparse({ why: { step: { name: 'inspect' } } }), 'inspect'],
      [sparse({ who: { principal: 'johannes' } }), '@johannes'],
    ] as const)
      expect(summaryText(view)).toBe(expected)
  })
  it('does not treat observed purpose or tooling as an identity', () => {
    const view = sparse({ how: { harness: { tool: 'OMP' } } })
    expect(renderFooterHuman({ view, audience: 'public-minimal' })).toContain(
      '<summary>Agent Trace · OMP</summary>',
    )
  })
  it('uses a neutral label rather than inventing attribution when all summary facts are absent', () => {
    const view = sparse()
    expect(summaryText(view)).toBe('')
    expect(renderTrailerHuman(view)).toBe('Agent: Agent Trace')
    expect(renderFooterHuman({ view, audience: 'public-minimal' })).toBe(
      '<details>\n<summary>Agent Trace</summary>\n\n\n</details>',
    )
  })
})
