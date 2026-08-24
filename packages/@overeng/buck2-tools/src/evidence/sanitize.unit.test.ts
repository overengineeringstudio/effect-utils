import { describe, expect, it } from 'vitest'

import { defaultSanitizationPolicy, sanitizeArgv, sanitizeEnv, sanitizeHostPath } from './sanitize.ts'

describe('sanitizeHostPath (R07)', () => {
  it('makes workspace-relative paths repo-scoped', () => {
    expect(
      sanitizeHostPath({
        path: '/home/dev/effect-utils/buck-out/v2/bin/demo',
        workspaceRoot: '/home/dev/effect-utils',
      }),
    ).toBe('buck-out/v2/bin/demo')
  })

  it('redacts host paths outside the workspace wholesale', () => {
    expect(sanitizeHostPath({ path: '/etc/passwd' })).toBe(defaultSanitizationPolicy.redactedPath)
    expect(
      sanitizeHostPath({
        path: '/home/otherdev/secrets/proj',
        workspaceRoot: '/home/dev/effect-utils',
      }),
    ).toBe(defaultSanitizationPolicy.redactedPath)
    expect(sanitizeHostPath({ path: '' })).toBe(defaultSanitizationPolicy.redactedPath)
  })
})

describe('sanitizeArgv (R07)', () => {
  it('keeps flag names and buck labels, redacts everything else', () => {
    expect(
      sanitizeArgv({
        argv: [
          'build',
          '--event-log',
          '/run/dir/events.log',
          '--profile=ci-debug-profile',
          '//apps/demo:bin',
        ],
      }),
    ).toStrictEqual(['[redacted]', '--event-log', '[redacted]', '--profile=[redacted]', '//apps/demo:bin'])
  })

  it('never leaks values embedded in free-form tokens', () => {
    const sanitized = sanitizeArgv({ argv: ['--modifies-workspace=/srv/private/token'] })
    expect(sanitized).toHaveLength(1)
    expect(sanitized[0]).not.toContain('/srv')
    expect(sanitized[0]).not.toContain('token')
  })
})

describe('sanitizeEnv (R07)', () => {
  it('exports only the count — no keys, no values', () => {
    const sanitized = sanitizeEnv({ SECRET_TOKEN: 'hunter2', PATH: '/usr/bin' })
    expect(sanitized.count).toBe(2)
    expect(JSON.stringify(sanitized)).not.toContain('SECRET')
    expect(JSON.stringify(sanitized)).not.toContain('hunter2')
  })
})
