/**
 * Test Utilities Module
 *
 * Exports all test helpers for megarepo tests.
 */

export {
  addCommit,
  createBareRepo,
  createRepo,
  createStore,
  createWorkspace,
  generateConfig,
  getGitRev,
  getGitRevShort,
  initGitRepo,
  normalizeOutput,
  readConfig,
  runGitCommand,
  stripAnsi,
  type RepoFixture,
  type WorkspaceFixture,
  type WorkspaceResult,
} from './setup.ts'

export { makeConsoleCapture } from './consoleCapture.ts'

export { makeWithTestCtx, withTestCtx } from './withTestCtx.ts'
