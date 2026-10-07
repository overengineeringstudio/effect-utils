import { equal, match, throws } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readFragments, run } from './changelog.mjs'

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'changelog-fragments-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'changelog.d'))
  writeFileSync(join(root, 'changelog.d/README.md'), '# Fragment instructions\n')
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Existing fix.\n',
  )
  return root
}

test('assembly consumes only fragments, preserves the README and is repeatable', (t) => {
  const root = fixture(t)
  writeFileSync(join(root, 'changelog.d/new-fix.fixed.md'), '- New fix.\n')
  match(run({ command: 'assemble', root, env: {} }), /Assembled 1 fragments/)
  equal(
    readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- New fix.\n- Existing fix.\n',
  )
  equal(existsSync(join(root, 'changelog.d/new-fix.fixed.md')), false)
  equal(existsSync(join(root, 'changelog.d/README.md')), true)
  const assembled = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  match(run({ command: 'assemble', root, env: {} }), /Assembled 0 fragments/)
  equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), assembled)
})

test('invalid inputs leave the changelog and all fragments untouched', (t) => {
  const root = fixture(t)
  const before = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  writeFileSync(join(root, 'changelog.d/good.fixed.md'), '- Valid fix.\n')
  writeFileSync(join(root, 'changelog.d/bad.fixed.md'), '')
  throws(() => run({ command: 'assemble', root, env: {} }), /Empty fragment/)
  equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), before)
  equal(existsSync(join(root, 'changelog.d/good.fixed.md')), true)
})

test('rejects fragment symlinks and unexpected nested directories', (t) => {
  const root = fixture(t)
  symlinkSync(join(root, 'CHANGELOG.md'), join(root, 'changelog.d/link.fixed.md'))
  throws(() => readFragments(root), /regular file/)
  rmSync(join(root, 'changelog.d/link.fixed.md'))
  mkdirSync(join(root, 'changelog.d/nested'))
  throws(() => readFragments(root), /regular file/)
})

test(
  'PR coverage uses actual PR history, rejects modifications and honors latest-commit trailers',
  { timeout: 30_000 },
  (t) => {
    const root = fixture(t)
    // Do not inherit worktree Git overrides or mutate the shared repository config.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith('GIT_') === false),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    }
    const git = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
    const commit = (message) => {
      git(['add', '.'])
      git([
        '-c',
        'user.name=Changelog Test',
        '-c',
        'user.email=changelog@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        message,
      ])
      return git(['rev-parse', 'HEAD'])
    }
    git(['init', '-b', 'main'])
    writeFileSync(join(root, 'changelog.d/existing.fixed.md'), '- Existing pending fix.\n')
    const base = commit('Initial state')
    git(['remote', 'add', 'origin', root])
    git(['checkout', '-b', 'feature'])
    const eventPath = join(root, '.git/event.json')
    const check = ({ baseSha = base, headSha = git(['rev-parse', 'HEAD']) } = {}) => {
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: headSha } } }),
      )
      return run({
        command: 'check',
        root,
        env: { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath },
      })
    }
    writeFileSync(join(root, 'changelog.d/existing.fixed.md'), '- Modified old fragment.\n')
    commit('Only modifies a fragment')
    throws(() => check(), /PR must add/)
    writeFileSync(join(root, 'changelog.d/feature.added.md'), '- New feature.\n')
    commit('New feature')
    equal(check(), 'PR adds a changelog fragment')
    // Move back to a no-fragment PR by removing its only new fragment.
    rmSync(join(root, 'changelog.d/feature.added.md'))
    commit('Tests only\n\nChangelog-None: No user-facing changes')
    equal(check(), 'Changelog exemption: No user-facing changes')
    commit('Follow-up without an exemption')
    throws(() => check(), /PR must add/)
    const prHead = git(['rev-parse', 'HEAD'])
    git(['checkout', 'main'])
    writeFileSync(
      join(root, 'changelog.d/unrelated-main.fixed.md'),
      '- Another PR already landed.\n',
    )
    const advancedBase = commit('Another PR')
    git(['checkout', 'feature'])
    git([
      '-c',
      'user.name=Changelog Test',
      '-c',
      'user.email=changelog@example.invalid',
      'merge',
      '--no-ff',
      '--no-commit',
      'main',
    ])
    // A synthetic merge checkout contains main's fragment, which must not count.
    throws(() => check({ baseSha: advancedBase, headSha: prHead }), /PR must add/)
  },
)
