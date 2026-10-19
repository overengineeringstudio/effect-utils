import { expect, it } from 'bun:test'

import { resolveGateInvocation } from './buck2-entrypoint.ts'

const resolveGateIsolation = (options: Parameters<typeof resolveGateInvocation>[0]) =>
  resolveGateInvocation(options)?.isolation

const cwd = '/project/subdir'
const files: Record<string, string> = {
  '/project/subdir/flags': '--isolation-dir\nowned\nbuild\n//:target\n',
  '/project/subdir/nested/outer': '@inner\n',
  '/project/subdir/inner': '--flagfile\nflags\n',
  '/project/subdir/comments': '\n--#ignored\n--isolation-dir=owned\r\nbuild\r\n',
  '/project/subdir/cycle': '@cycle\n',
  '/project/subdir/python-link': '--isolation-dir=owned\nbuild\n',
  '/project/subdir/after-sentinel': '--\n@missing\n--isolation-dir=ignored\n',
}
const readArgfile = (path: string) => {
  const contents = files[path]
  if (contents === undefined) throw new Error('unresolved fixture argfile')
  return { path: path === '/project/subdir/python-link' ? '/project/mode.py' : path, contents }
}

it('uses the native default and BUCK_ISOLATION_DIR, with CLI taking precedence', () => {
  expect(resolveGateIsolation({ args: ['build'], env: {}, cwd })).toBe('v2')
  expect(
    resolveGateIsolation({ args: ['build'], env: { BUCK_ISOLATION_DIR: 'environment' }, cwd }),
  ).toBe('environment')
  for (const args of [
    ['--isolation-dir', 'owned', 'build'],
    ['build', '--isolation-dir=owned'],
  ])
    expect(resolveGateIsolation({ args, env: { BUCK_ISOLATION_DIR: 'environment' }, cwd })).toBe(
      'owned',
    )
})

it('expands @file and --flagfile as newline arguments, including CRLF and native comments', () => {
  for (const args of [['@flags'], ['--flagfile', 'flags'], ['@comments']])
    expect(resolveGateIsolation({ args, env: {}, cwd, readArgfile })).toBe('owned')
})

it('resolves nested files against invocation cwd, never the including directory', () => {
  expect(resolveGateIsolation({ args: ['@nested/outer'], env: {}, cwd, readArgfile })).toBe('owned')
})

it('stops expansion at a sentinel within each argfile and ignores isolation in payload arguments', () => {
  expect(
    resolveGateIsolation({ args: ['build', '@after-sentinel'], env: {}, cwd, readArgfile }),
  ).toBe('v2')
  expect(
    resolveGateIsolation({
      args: ['run', '--', '@missing', '--isolation-dir=ignored'],
      env: {},
      cwd,
      readArgfile,
    }),
  ).toBe('v2')
  // Buck still expands outer arguments after an inner file's local sentinel.
  expect(
    resolveGateIsolation({
      args: ['build', '@after-sentinel', '@missing'],
      env: {},
      cwd,
      readArgfile,
    }),
  ).toBeUndefined()
})

it('does not confuse build config values with an isolation source', () => {
  expect(
    resolveGateIsolation({
      args: ['build', '--config', 'buck2.isolation_dir=other', '--config-file', 'settings.bcfg'],
      env: {},
      cwd,
      readArgfile,
    }),
  ).toBe('v2')
})

it('retains daemons for config-backed cell resolution, missing fallback files, stdin and executable argfiles', () => {
  for (const args of [
    ['@cell//flags', 'build'],
    ['@//flags', 'build'],
    ['@missing', 'build'],
    ['@-', 'build'],
    ['--flagfile', '-', 'build'],
    ['@mode.py#flavor', 'build'],
    ['@python-link', 'build'],
    ['@cycle', 'build'],
  ])
    expect(resolveGateIsolation({ args, env: {}, cwd, readArgfile })).toBeUndefined()
})

it('never guesses an identity for malformed or unsupported isolation/argfile arguments', () => {
  for (const args of [
    ['build', '--isolation-dir'],
    ['build', '--isolation-dir='],
    ['build', '--isolation-dir', '..'],
    ['build', '--isolation-dir=../other'],
    ['build', '--isolation-dir=._buck2reserved'],
    ['build', '--isolation-dir=one', '--isolation-dir=two'],
    ['@flags', '--isolation-dir=two'],
    ['build', '--isolation=other'],
    ['build', '--flagfile'],
    ['build', '--flagfile=flags'],
    ['build', '@'],
    ['build', '@/project/subdir/../flags'],
  ])
    expect(resolveGateIsolation({ args, env: {}, cwd, readArgfile })).toBeUndefined()
  expect(
    resolveGateIsolation({ args: ['build'], env: { BUCK_ISOLATION_DIR: '' }, cwd }),
  ).toBeUndefined()
})
