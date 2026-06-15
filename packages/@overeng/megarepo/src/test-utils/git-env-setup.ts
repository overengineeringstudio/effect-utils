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
 * OTLP needs no handling here: the bulk tests run `mrCommand` WITHOUT providing
 * `makeOtelCliLayer`, so no exporter is ever built and no `OtelConfig` is in
 * context — telemetry is structurally off regardless of any ambient
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. The endpoint is now resolved at the binary's
 * composition root (Effect `Config`) and passed explicitly into the layer, so
 * the layer never reads `process.env`; tests that DO assert telemetry stand up
 * their own ephemeral otelite receiver and pass its endpoint into the layer
 * within their own scope.
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
