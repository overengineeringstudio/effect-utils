import { describe, it, expect } from '@effect/vitest'
import { parseTaskLine, parseTasksFile, parseResultFile } from './schema.ts'

describe('parseTaskLine', () => {
  it('parses simple task:ok', () => {
    expect(parseTaskLine('genie:run:ok')).toEqual({ name: 'genie:run', status: 'ok' })
  })

  it('parses task:warning', () => {
    expect(parseTaskLine('ts:check:warning')).toEqual({ name: 'ts:check', status: 'warning' })
  })

  it('parses single-segment task name', () => {
    expect(parseTaskLine('build:ok')).toEqual({ name: 'build', status: 'ok' })
  })

  it('parses multi-colon task name', () => {
    expect(parseTaskLine('pnpm:install:ok')).toEqual({ name: 'pnpm:install', status: 'ok' })
  })

  it('returns undefined for empty line', () => {
    expect(parseTaskLine('')).toBeUndefined()
    expect(parseTaskLine('  ')).toBeUndefined()
  })

  it('returns undefined for invalid status', () => {
    expect(parseTaskLine('task:invalid')).toBeUndefined()
  })

  it('returns undefined for line without colon', () => {
    expect(parseTaskLine('nocolon')).toBeUndefined()
  })
})

describe('parseTasksFile', () => {
  it('parses multi-line tasks file', () => {
    const content = `pnpm:install:ok
genie:run:ok
ts:check:warning
nix:hash:ok`
    const results = parseTasksFile(content)
    expect(results).toEqual([
      { name: 'pnpm:install', status: 'ok' },
      { name: 'genie:run', status: 'ok' },
      { name: 'ts:check', status: 'warning' },
      { name: 'nix:hash', status: 'ok' },
    ])
  })

  it('skips empty lines', () => {
    const content = `task1:ok

task2:warning
`
    const results = parseTasksFile(content)
    expect(results).toEqual([
      { name: 'task1', status: 'ok' },
      { name: 'task2', status: 'warning' },
    ])
  })
})

describe('parseResultFile', () => {
  it('parses a full result file', () => {
    const content = `STATUS=created
PR_NUMBER=123
PR_URL=https://github.com/owner/repo/pull/123
FILES_CHANGED=5
SAFE_ONLY=true
AUTO_MERGE=enabled
REPO_SLUG=owner/repo`
    const result = parseResultFile(content)
    expect(result).toEqual({
      status: 'created',
      prNumber: 123,
      prUrl: 'https://github.com/owner/repo/pull/123',
      filesChanged: 5,
      safeOnly: true,
      autoMerge: 'enabled',
      repoSlug: 'owner/repo',
    })
  })

  it('parses no-changes result', () => {
    const content = 'STATUS=no-changes'
    const result = parseResultFile(content)
    expect(result.status).toBe('no-changes')
  })

  it('parses result with needs-review auto-merge', () => {
    const content = `STATUS=updated
PR_NUMBER=456
SAFE_ONLY=false
AUTO_MERGE=needs-review
REPO_SLUG=owner/repo`
    const result = parseResultFile(content)
    expect(result.status).toBe('updated')
    expect(result.safeOnly).toBe(false)
    expect(result.autoMerge).toBe('needs-review')
  })

  it('defaults to skipped for unknown status', () => {
    const content = 'STATUS=unknown'
    const result = parseResultFile(content)
    expect(result.status).toBe('skipped')
  })
})
