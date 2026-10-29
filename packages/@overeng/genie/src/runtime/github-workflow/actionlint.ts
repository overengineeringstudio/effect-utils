import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GenieActionlintConfig, GenieActionlintRunner } from '../core.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

/** Configuration for actionlint validation (alias of the shared {@link GenieActionlintConfig}). */
export type ActionlintConfig = GenieActionlintConfig

type ActionlintJsonIssue = {
  message: string
  filepath: string
  line: number
  column: number
  kind: string
  snippet: string
  end_column: number
}

/** shellcheck/pyflakes info/style issues are warnings; everything else is an error */
const deriveSeverity = ({
  kind,
  message,
}: {
  kind: string
  message: string
}): 'error' | 'warning' => {
  if (kind === 'shellcheck' || kind === 'pyflakes') {
    if (/:info:/.test(message) === true || /:style:/.test(message) === true) return 'warning'
  }
  return 'error'
}

/**
 * Run actionlint and log any issues to stderr.
 *
 * This is the node-only runner the genie engine injects as the `ctx.actionlint` capability (typed as
 * {@link GenieActionlintRunner}); it owns the stderr reporting that previously lived in the (now pure)
 * `githubWorkflow` validator.
 */
export const runActionlint: GenieActionlintRunner = (args) => {
  const result = runActionlintRaw(args)
  if (result.issues.length > 0) {
    console.error(
      `[genie/actionlint] ${args.location}: ${result.issues.length} issue(s) in ${result.durationMs.toFixed(0)}ms`,
    )
    for (const issue of result.issues) {
      console.error(`  [${issue.severity}] ${issue.rule}: ${issue.message}`)
    }
  }
  return result
}

/** Run actionlint on a YAML string via stdin, returning structured validation issues and timing data */
const runActionlintRaw = ({
  yaml,
  location,
  config,
}: {
  yaml: string
  location: string
  config?: ActionlintConfig
}): { issues: GenieValidationIssue[]; durationMs: number } => {
  const start = performance.now()

  const bin = resolveActionlintBin()
  if (bin === undefined) {
    return {
      issues: [
        {
          severity: 'warning',
          packageName: location,
          dependency: 'actionlint',
          message:
            'actionlint not found on PATH — skipping workflow validation. Add actionlint to your devenv packages.',
          rule: 'actionlint-not-found',
        },
      ],
      durationMs: performance.now() - start,
    }
  }

  const args: string[] = [
    '-format',
    '{{json .}}',
    /** Disable shellcheck/pyflakes — generated CI scripts have intentional patterns that trigger false positives */
    '-shellcheck=',
    '-pyflakes=',
  ]

  let configDir: string | undefined
  if (config?.ignorePatterns !== undefined) {
    for (const pattern of config.ignorePatterns) {
      args.push('-ignore', pattern)
    }
  }

  args.push('-')

  try {
    if (config?.selfHostedRunnerLabels !== undefined && config.selfHostedRunnerLabels.length > 0) {
      configDir = mkdtempSync(join(tmpdir(), 'genie-actionlint-'))
      const configPath = join(configDir, 'actionlint.yaml')
      const labels = config.selfHostedRunnerLabels
      writeFileSync(
        configPath,
        `self-hosted-runner:\n  labels:\n${labels.map((label) => `    - ${label}`).join('\n')}\n`,
      )
      args.unshift('-config-file', configPath)
    }

    const proc = spawnSync(bin, args, {
      input: yaml,
      encoding: 'utf-8',
      timeout: 30_000,
    })

    const durationMs = performance.now() - start

    // Exit 0 = clean, 1 = issues found, >=2 = fatal
    if (proc.status === 0) {
      return { issues: [], durationMs }
    }

    if (proc.status !== null && proc.status >= 2) {
      return {
        issues: [
          {
            severity: 'error',
            packageName: location,
            dependency: 'actionlint',
            message: `actionlint crashed (exit ${proc.status}): ${proc.stderr ?? ''}`,
            rule: 'actionlint-crash',
          },
        ],
        durationMs,
      }
    }

    const stdout = proc.stdout ?? ''
    if (stdout.trim() === '') return { issues: [], durationMs }

    const parsed: ActionlintJsonIssue[] = JSON.parse(stdout)

    const issues: GenieValidationIssue[] = parsed.map((issue) => ({
      severity: deriveSeverity({ kind: issue.kind, message: issue.message }),
      packageName: location,
      dependency: `line:${issue.line}:${issue.column}`,
      message: `[actionlint/${issue.kind}] ${issue.message}`,
      rule: `actionlint-${issue.kind}`,
    }))

    return { issues, durationMs }
  } finally {
    if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true })
  }
}

/**
 * Resolve actionlint binary via GENIE_ACTIONLINT_BIN env var.
 * Set by the packaged product wrapper (`--set GENIE_ACTIONLINT_BIN`, declared as
 * the `actionlint` external capability) to avoid subprocess overhead.
 */
const resolveActionlintBin = (): string | undefined => {
  const bin = process.env.GENIE_ACTIONLINT_BIN
  if (bin !== undefined && bin !== '') return bin
  return undefined
}
