import { describe, expect, it } from 'vitest'

import {
  abbreviateRunner,
  formatDuration,
  parseRunnerIdentity,
} from '../src/isomorphic/lib/format.ts'

describe('formatDuration', () => {
  it('formats seconds', () => expect(formatDuration(45)).toBe('45s'))
  it('formats minutes', () => expect(formatDuration(125)).toBe('2m 05s'))
  it('formats hours', () => expect(formatDuration(7877)).toBe('2h 11m'))
  it('handles zero', () => expect(formatDuration(0)).toBe('0s'))
  it('handles exactly 1 hour', () => expect(formatDuration(3600)).toBe('1h 00m'))
})

describe('abbreviateRunner', () => {
  it('abbreviates nsc runners', () =>
    expect(abbreviateRunner('nsc-runner-psmnb4mkjm3mq')).toBe('nsc:psmnb4'))
  it('abbreviates self-hosted runner-scaler names', () => {
    expect(abbreviateRunner('dev3-6038ddf9')).toBe('dev3')
    expect(abbreviateRunner('mbp2021-e2387a32')).toBe('mbp2021')
  })
  it('passes through non-matching names', () =>
    expect(abbreviateRunner('some-other-runner')).toBe('some-other-runner'))
  it('handles null', () => expect(abbreviateRunner(null)).toBe('—'))
})

describe('parseRunnerIdentity', () => {
  it('keeps the full Namespace runner id, not just the abbreviated prefix', () =>
    expect(parseRunnerIdentity({ name: 'nsc-runner-psmnb4mkjm3mq' })).toEqual({
      _tag: 'namespace',
      instance: 'psmnb4mkjm3mq',
    }))

  it('resolves self-hosted runner-scaler workers to their host', () => {
    expect(parseRunnerIdentity({ name: 'dev3-6038ddf9' })).toEqual({
      _tag: 'self-hosted',
      instance: 'dev3',
    })
    expect(parseRunnerIdentity({ name: 'mbp2021-e2387a32' })).toEqual({
      _tag: 'self-hosted',
      instance: 'mbp2021',
    })
  })

  it('reports unrecognized names verbatim rather than guessing a scheme', () => {
    expect(parseRunnerIdentity({ name: 'some-other-runner' })).toEqual({
      _tag: 'other',
      instance: 'some-other-runner',
    })
    expect(parseRunnerIdentity({ name: 'ubuntu-latest' })).toEqual({
      _tag: 'other',
      instance: 'ubuntu-latest',
    })
  })

  it('distinguishes "no runner assigned" from an unrecognized runner', () =>
    expect(parseRunnerIdentity({ name: null })).toEqual({ _tag: 'unknown', instance: null }))
})
