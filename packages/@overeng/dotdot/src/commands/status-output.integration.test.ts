/**
 * Integration tests for dotdot status command output rendering
 *
 * Tests that the status command produces the expected output format
 * as defined in the CLI style guide.
 *
 * @see /context/cli-design/CLI_STYLE_GUIDE.md
 */

import { FileSystem } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { CurrentWorkingDirectory, WorkspaceService } from '../lib/mod.ts'
import {
  createWorkspace,
  generateRootConfig,
  getGitRev,
  normalizeStatusOutput,
  withTestCtx,
} from '../test-utils/mod.ts'
import { renderStyledStatus } from './status-renderer.ts'

/** Helper to create WorkspaceService layer for a test workspace */
const withWorkspaceService = (workspacePath: string) =>
  WorkspaceService.live.pipe(Layer.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

describe('status command output', () => {
  it('renders workspace with problems (CRITICAL + WARNING sections)', { timeout: 30_000 }, () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with:
        // - 3 existing repos: project-a, project-b, shared-lib
        // - 1 missing repo: missing-dep (CRITICAL)
        // - 2 diverged: project-a, project-b (WARNING)
        // - All existing repos are dirty (WARNING)
        // - project-b has many packages (to test truncation)

        const workspacePath = yield* createWorkspace({
          repos: [
            // project-a - member with deps, dirty, will be diverged
            {
              name: 'project-a',
              isGitRepo: true,
              isDirty: true,
              hasConfig: true,
              configDeps: {
                'shared-lib': { url: 'git@github.com:test/shared-lib.git' },
              },
            },
            // project-b - member with many links, dirty, will be diverged
            {
              name: 'project-b',
              isGitRepo: true,
              isDirty: true,
              hasConfig: true,
              configDeps: {
                'shared-lib': { url: 'git@github.com:test/shared-lib.git' },
              },
              configExposes: {
                '@scope/package-one': { path: 'packages/package-one' },
                '@scope/package-two': { path: 'packages/package-two' },
                '@scope/package-three': { path: 'packages/package-three' },
                '@scope/package-four': { path: 'packages/package-four' },
                '@scope/package-five': { path: 'packages/package-five' },
                '@scope/package-six': { path: 'packages/package-six' },
                '@scope/package-seven': { path: 'packages/package-seven' },
                '@scope/package-eight': { path: 'packages/package-eight' },
                '@scope/package-nine': { path: 'packages/package-nine' },
                '@scope/package-ten': { path: 'packages/package-ten' },
                '@scope/package-eleven': { path: 'packages/package-eleven' },
                '@scope/package-twelve': { path: 'packages/package-twelve' },
              },
            },
            // project-c - member with deps, dirty
            {
              name: 'project-c',
              isGitRepo: true,
              isDirty: true,
              hasConfig: true,
              configDeps: {
                'shared-lib': { url: 'git@github.com:test/shared-lib.git' },
              },
            },
            // shared-lib - dependency (not a member), clean
            {
              name: 'shared-lib',
              isGitRepo: true,
            },
          ],
        })

        // Get actual revs for repos that should match pinned revs (not diverged)
        const projectCRev = yield* getGitRev(`${workspacePath}/project-c`)
        const sharedLibRev = yield* getGitRev(`${workspacePath}/shared-lib`)

        // Create fake "pinned" revs that differ from current (to simulate diverged state)
        const projectAPinnedRev = 'abc12340000000000000000000000000deadbeef'
        const projectBPinnedRev = 'def56780000000000000000000000000deadbeef'

        // Write root config with all repos (including missing missing-dep)
        const rootConfig = generateRootConfig({
          repos: {
            'project-a': {
              url: 'git@github.com:test/project-a.git',
              rev: projectAPinnedRev, // Diverged - pinned rev differs from current
            },
            'project-b': {
              url: 'git@github.com:test/project-b.git',
              rev: projectBPinnedRev, // Diverged
            },
            'project-c': {
              url: 'git@github.com:test/project-c.git',
              rev: projectCRev, // Not diverged
            },
            'shared-lib': {
              url: 'git@github.com:test/shared-lib.git',
              rev: sharedLibRev, // Not diverged
            },
            'missing-dep': {
              url: 'git@github.com:test/missing-dep.git',
              // Missing - this repo doesn't exist (CRITICAL issue)
            },
          },
          packages: {
            // project-b packages (12 total to test truncation)
            '@scope/package-one': { repo: 'project-b', path: 'packages/package-one' },
            '@scope/package-two': { repo: 'project-b', path: 'packages/package-two' },
            '@scope/package-three': { repo: 'project-b', path: 'packages/package-three' },
            '@scope/package-four': { repo: 'project-b', path: 'packages/package-four' },
            '@scope/package-five': { repo: 'project-b', path: 'packages/package-five' },
            '@scope/package-six': { repo: 'project-b', path: 'packages/package-six' },
            '@scope/package-seven': { repo: 'project-b', path: 'packages/package-seven' },
            '@scope/package-eight': { repo: 'project-b', path: 'packages/package-eight' },
            '@scope/package-nine': { repo: 'project-b', path: 'packages/package-nine' },
            '@scope/package-ten': { repo: 'project-b', path: 'packages/package-ten' },
            '@scope/package-eleven': { repo: 'project-b', path: 'packages/package-eleven' },
            '@scope/package-twelve': { repo: 'project-b', path: 'packages/package-twelve' },
          },
        })

        yield* fs.writeFileString(`${workspacePath}/dotdot-root.json`, rootConfig)

        // Get workspace data using the service
        const workspace = yield* WorkspaceService.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )
        const allRepos = yield* workspace.scanRepos()
        const packages = workspace.rootConfig.config.packages ?? {}

        // Render styled output
        const lines = renderStyledStatus({
          workspaceRoot: workspace.root,
          allRepos,
          packages,
          memberConfigs: workspace.memberConfigs,
        })

        const normalizedOutput = normalizeStatusOutput(
          lines.join('\n'),
          workspacePath.split('/').pop(),
        )

        expect(normalizedOutput).toMatchSnapshot()
      }),
    ),
  )

  it('renders clean workspace (no problems)', { timeout: 30_000 }, () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a clean workspace: no dirty repos, no divergence, no missing deps
        const workspacePath = yield* createWorkspace({
          repos: [
            {
              name: 'repo-a',
              isGitRepo: true,
              isDirty: false,
              hasConfig: true,
            },
            {
              name: 'repo-b',
              isGitRepo: true,
              isDirty: false,
              hasConfig: true,
            },
          ],
        })

        // Get actual revs and pin them (no divergence)
        const repoARev = yield* getGitRev(`${workspacePath}/repo-a`)
        const repoBRev = yield* getGitRev(`${workspacePath}/repo-b`)

        const rootConfig = generateRootConfig({
          repos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git', rev: repoARev },
            'repo-b': { url: 'git@github.com:test/repo-b.git', rev: repoBRev },
          },
        })

        yield* fs.writeFileString(`${workspacePath}/dotdot-root.json`, rootConfig)

        // Get workspace data using the service
        const workspace = yield* WorkspaceService.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )
        const allRepos = yield* workspace.scanRepos()
        const packages = workspace.rootConfig.config.packages ?? {}

        // Render styled output
        const lines = renderStyledStatus({
          workspaceRoot: workspace.root,
          allRepos,
          packages,
          memberConfigs: workspace.memberConfigs,
        })

        const normalizedOutput = normalizeStatusOutput(
          lines.join('\n'),
          workspacePath.split('/').pop(),
        )

        expect(normalizedOutput).toMatchSnapshot()
      }),
    ),
  )
})
