import { redactDeployDiagnosticText } from './deploy-domain.ts'

export type LiveDeployProcessResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Public CI failure output must not expose provider credentials or deployment URLs. */
export const formatLiveDeployFailure = (
  opts: LiveDeployProcessResult & {
    readonly report: string | undefined
    readonly secretValues: readonly string[]
  },
): string =>
  redactDeployDiagnosticText(
    [
      `ci-tools exit status: ${opts.status}`,
      `stdout:\n${opts.stdout}`,
      `stderr:\n${opts.stderr}`,
      `workflow report:\n${opts.report ?? '(not written)'}`,
    ]
      .join('\n\n')
      .replace(/https?:\/\/[^\s"'<>]+/giu, '[REDACTED URL]'),
    { secretValues: opts.secretValues },
  )
