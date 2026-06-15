/**
 * Hermetic test environment for the suite.
 *
 * Imported as a vitest `setupFiles` entry so it runs before any test spawns a
 * git subprocess or builds the CLI runtime.
 *
 * Git: the suite inherits the host/CI git config without this, causing two
 * CI-only failures — no global committer identity (so `git commit` inside store
 * worktrees silently no-ops, e.g. `unpushedCommitCount` reads 0) and a `master`
 * `init.defaultBranch` while fixtures assume `main`. We write a private gitconfig
 * and point git at it via `GIT_CONFIG_GLOBAL`, pin `GIT_CONFIG_SYSTEM` to
 * `/dev/null`, and export the author/committer identity directly.
 *
 * OTLP: the dev shell sets `OTEL_EXPORTER_OTLP_ENDPOINT`, which makes the store
 * gc fork its real-time RSS sampler. Under a test's fixed/zero-sleep clock that
 * periodic fiber busy-spins and hangs the test. Tests must be hermetic anyway
 * (no export to the dev collector); the gc's instrumentation is verified in the
 * dedicated OTEL sweep, not in unit tests. So unset the endpoint here.
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

// Hermetic OTLP: no export to the dev collector, and no RSS-sampler fiber (which
// busy-spins under a test's fixed/zero-sleep clock — the gc instrumentation is
// exercised by the OTEL sweep, not unit tests).
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
