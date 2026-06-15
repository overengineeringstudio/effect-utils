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
 * OTLP: the suite is hermetic by policy — it never exports telemetry to an
 * ambient collector. The dev shell sets `OTEL_EXPORTER_OTLP_ENDPOINT`, so we
 * unset it here to keep the bulk (verdict) tests from POSTing to the dev
 * collector. Tests that DO assert telemetry stand up their own ephemeral otelite
 * receiver and set the endpoint within their own scope, so they remain hermetic
 * by construction and are unaffected by this global unset.
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

// Hermetic OTLP policy: the bulk suite never exports to an ambient collector.
// Telemetry-asserting tests opt back in with their own ephemeral receiver inside
// their own scope (and unset it on scope close), so this global default does not
// interfere with them.
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
