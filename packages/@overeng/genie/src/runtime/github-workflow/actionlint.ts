import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GenieValidationIssue } from '../validation/mod.ts'

type ActionlintJsonIssue = {
  message: string
  filepath: string
  line: number
  column: number
  kind: string
  snippet: string
  end_column: number
}

/** Configuration for actionlint validation in `githubWorkflow()` */
export type ActionlintConfig = {
  /** Custom self-hosted runner labels (suppresses "unknown label" errors) */
  selfHostedRunnerLabels?: readonly string[]
  /** Extra `-ignore` regex patterns passed to actionlint */
  ignorePatterns?: readonly string[]
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

/** Build a temporary actionlint YAML config with self-hosted runner labels. */
const writeConfigFile = (labels: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'genie-actionlint-'))
  const configPath = join(dir, 'actionlint.yaml')
  const yaml = `self-hosted-runner:\n  labels:\n${labels.map((l) => `    - ${l}`).join('\n')}\n`
  writeFileSync(configPath, yaml)
  return configPath
}

/** Run actionlint on a YAML string via stdin, returning structured validation issues and timing data */
export const runActionlint = ({
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

  let configPath: string | undefined
  if (config?.selfHostedRunnerLabels !== undefined && config.selfHostedRunnerLabels.length > 0) {
    configPath = writeConfigFile(config.selfHostedRunnerLabels)
    args.push('-config-file', configPath)
  }

  if (config?.ignorePatterns !== undefined) {
    for (const pattern of config.ignorePatterns) {
      args.push('-ignore', pattern)
    }
  }

  args.push('-')

  try {
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
    if (configPath !== undefined) {
      try {
        rmSync(configPath, { recursive: true })
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Resolve actionlint binary from PATH. Returns undefined if not found. */
const resolveActionlintBin = (): string | undefined => {
  try {
    const result = spawnSync('which', ['actionlint'], { encoding: 'utf-8', timeout: 5_000 })
    if (result.status === 0 && result.stdout.trim() !== '') {
      return result.stdout.trim()
    }
    return undefined
  } catch {
    return undefined
  }
}
