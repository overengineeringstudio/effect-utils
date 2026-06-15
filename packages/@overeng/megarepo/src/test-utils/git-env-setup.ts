/**
 * Hermetic git environment for the test suite.
 *
 * Imported as a vitest `setupFiles` entry so it runs before any test spawns a
 * git subprocess. Without this, the suite inherits the host/CI git config,
 * which causes two CI-only failures:
 *
 * - CI has no global committer identity, so `git commit` inside store
 *   worktrees silently no-ops (e.g. `unpushedCommitCount` reads 0).
 * - CI defaults `init.defaultBranch` to `master`, while fixtures assume `main`.
 *
 * To make every git subprocess deterministic regardless of host/CI config we
 * write a private gitconfig and point git at it via `GIT_CONFIG_GLOBAL`, pin
 * `GIT_CONFIG_SYSTEM` to `/dev/null`, and export the author/committer identity
 * directly (belt-and-suspenders so commits never depend on config lookup).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const identity = {
  name: 'Test User',
  email: 'test@example.com',
} as const

const configDir = mkdtempSync(join(tmpdir(), 'megarepo-git-env-'))
const configPath = join(configDir, 'gitconfig')

writeFileSync(
  configPath,
  `[init]\n\tdefaultBranch = main\n[user]\n\temail = ${identity.email}\n\tname = ${identity.name}\n`,
)

process.env.GIT_CONFIG_GLOBAL = configPath
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.GIT_AUTHOR_NAME = identity.name
process.env.GIT_AUTHOR_EMAIL = identity.email
process.env.GIT_COMMITTER_NAME = identity.name
process.env.GIT_COMMITTER_EMAIL = identity.email
