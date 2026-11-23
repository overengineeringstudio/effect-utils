import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { makeChangelogContract, NonEmptyTrimmedString } from '../contract.ts'
import { checkChangelog, collectGitChanges } from './check.ts'
import type { ChangelogConfig } from './config.ts'

const contract = makeChangelogContract({
  product: 'demo',
  text: NonEmptyTrimmedString,
  fields: { area: Schema.Literal('chat') },
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repo whose product lives in `app/`, with `main` as the base branch. */
const makeRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), 'changelog-check-'))
  roots.push(repo)
  // Fixture commits must not run the developer's global hooks (identity guards, formatters).
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).toString()
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), content)
  }
  git('init', '--quiet', '--initial-branch=main')
  write('app/src/chat.ts', 'v1\n')
  write('app/.changelog/2026-11-20-chat.ts', `export const entry = { title: 'Chat', summary: 'Talk.', area: 'chat' }\n`)
  write('README.md', 'repo\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'init')
  git('switch', '--quiet', '-c', 'feature')
  const config: ChangelogConfig<string, { readonly area: 'chat' }> = {
    contract,
    root: join(repo, 'app'),
    sourcePaths: ['src/**'],
    screenshots: {
      viewports: [],
      schemes: [],
      themes: {
        light: { ink: '', badgeFill: '', badgeInk: '', captionInk: '', captionHalo: '', highlight: '', fontFamily: '' },
        dark: { ink: '', badgeFill: '', badgeInk: '', captionInk: '', captionHalo: '', highlight: '', fontFamily: '' },
      },
      inputs: [],
      renderText: (text) => text,
    },
  }
  return { git, write, config }
}

const check = (config: ChangelogConfig<string, { readonly area: 'chat' }>) =>
  checkChangelog({ config, base: 'main' }).pipe(Effect.provide(NodeServices.layer))

describe('checkChangelog coverage', () => {
  it.effect('collects committed, unstaged and untracked changes relative to the product', () =>
    Effect.gen(function* () {
      const { git, write, config } = makeRepo()
      write('app/src/chat.ts', 'v2\n')
      git('commit', '--quiet', '-am', 'feat: chat v2\n\nbody')
      write('app/src/new.ts', 'new\n')
      write('README.md', 'outside the product\n')
      const changes = yield* collectGitChanges({ root: config.root, base: 'main' }).pipe(
        Effect.provide(NodeServices.layer),
      )
      expect(changes.changedFiles).toEqual([
        { path: 'src/chat.ts', status: 'M' },
        { path: 'src/new.ts', status: 'A' },
      ])
      expect(changes.commitMessages).toEqual(['feat: chat v2\n\nbody'])
    }),
  )

  it.effect('fails when source changes ship without an entry or waiver', () =>
    Effect.gen(function* () {
      const { git, write, config } = makeRepo()
      write('app/src/chat.ts', 'v2\n')
      git('commit', '--quiet', '-am', 'feat: chat v2')
      const error = yield* Effect.flip(check(config))
      expect(error._tag).toBe('ChangelogCheckError')
      expect(error.message).toContain('src/chat.ts')
    }),
  )

  it.effect('passes with a new entry, or with a waiver line', () =>
    Effect.gen(function* () {
      const covered = makeRepo()
      covered.write('app/src/chat.ts', 'v2\n')
      covered.write(
        'app/.changelog/2026-11-23-chat-v2.ts',
        `export const entry = { title: 'Chat 2', summary: 'Better.', area: 'chat' }\n`,
      )
      const report = yield* check(covered.config)
      expect(report.coverage._tag).toBe('CoveredByEntry')
      expect(report.entries).toBe(2)

      const waived = makeRepo()
      waived.write('app/src/chat.ts', 'v2\n')
      waived.git('commit', '--quiet', '-am', 'refactor: x\n\nchangelog: none — internal rename')
      expect((yield* check(waived.config)).coverage._tag).toBe('Waived')
    }),
  )

  it.effect('reports unavailable history only when asked to', () =>
    Effect.gen(function* () {
      const { config } = makeRepo()
      const missing = checkChangelog({ config, base: 'origin/nowhere' })
      expect((yield* Effect.flip(missing.pipe(Effect.provide(NodeServices.layer))))._tag).toBe(
        'ChangelogGitError',
      )
      const report = yield* checkChangelog({
        config,
        base: 'origin/nowhere',
        missingHistory: 'report',
      }).pipe(Effect.provide(NodeServices.layer))
      expect(report.coverage._tag).toBe('Unavailable')
    }),
  )
})
