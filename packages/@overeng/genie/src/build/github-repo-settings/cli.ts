import { Effect, Option } from 'effect'
import * as Cli from 'effect/cli'

import {
  formatGithubRepoSettingsReport,
  GithubRepoSettingsError,
  reconcileGithubRepoSettings,
} from './reconcile.ts'

/** Shared by the plain-flake apps and devenv's thin task wrappers. */
export const githubSettingsCommand = Cli.Command.make(
  'github-settings',
  {
    mode: Cli.Flag.Literals('mode', ['apply', 'check']).pipe(
      Cli.Flag.withDescription('Apply desired settings, or read-only check for drift'),
    ),
    repo: Cli.Flag.String('repo').pipe(Cli.Flag.withDescription('GitHub repository owner/name')),
    file: Cli.Flag.String('file').pipe(
      Cli.Flag.withDescription(
        'Generated repository settings JSON (legacy ruleset JSON also accepted)',
      ),
      Cli.Flag.withDefault('.github/repo-settings.json'),
    ),
    ruleset: Cli.Flag.String('ruleset').pipe(
      Cli.Flag.withDescription('Assert the expected ruleset name (legacy task compatibility)'),
      Cli.Flag.optional,
    ),
  },
  Effect.fn('genie/github-settings')(function* ({ mode, repo, file, ruleset }) {
    const report = yield* Effect.tryPromise({
      try: () =>
        reconcileGithubRepoSettings({
          mode,
          options: { repo, file, ruleset: Option.getOrUndefined(ruleset) },
        }),
      catch: (cause) =>
        new GithubRepoSettingsError({
          message: `Cannot ${mode} GitHub repository settings for ${repo}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    })
    // Human-readable CLI output is stdout, without Effect log prefixes.
    yield* Effect.sync(() => {
      process.stdout.write(`${formatGithubRepoSettingsReport({ mode, report })}\n`)
      if (mode === 'check' && report.changed === true) process.exitCode = 1
    })
  }),
).pipe(Cli.Command.withDescription('Reconcile GitHub repository settings and named rulesets'))
