/**
 * Export sanitization policy (BUCK.OBS-R07).
 *
 * Raw argv, environment values, host paths, and repository-private identities
 * are omitted or transformed by THIS explicit policy before anything reaches
 * telemetry. The default policy is fail-closed: any token that is not
 * provably public is redacted. High-cardinality sanitized values may still go
 * on spans (spec "Signals"), but never on metric labels (BUCK.OBS-R06 —
 * enforced separately in `evidence-expect.ts`).
 */

/** Tunable redaction markers; the defaults are deliberately non-informative. */
export interface SanitizationPolicy {
  /** Replacement for argv tokens that are neither a known flag shape nor a Buck label. */
  readonly redactedValue: string
  /** Replacement for host paths outside the workspace root. */
  readonly redactedPath: string
}

/** The fail-closed default policy. */
export const defaultSanitizationPolicy: SanitizationPolicy = {
  redactedPath: '[host-path]',
  redactedValue: '[redacted]',
}

/**
 * Transform one host path for export. Paths under `workspaceRoot` become
 * repo-relative; everything else is replaced wholesale — no basenames, no
 * user names, no home directories leak.
 */
export const sanitizeHostPath = ({
  path,
  policy = defaultSanitizationPolicy,
  workspaceRoot,
}: {
  readonly path: string
  readonly policy?: SanitizationPolicy | undefined
  readonly workspaceRoot?: string | undefined
}): string => {
  if (path === '') {
    return policy.redactedPath
  }
  const root = workspaceRoot
  if (root !== undefined && root !== '') {
    // explicit-compare form below satisfies overeng/explicit-boolean-compare
    const prefix = root.endsWith('/') === true ? root : `${root}/`
    if (path.startsWith(prefix) === true && path.length > prefix.length) {
      return path.slice(prefix.length)
    }
  }
  return policy.redactedPath
}

const SAFE_FLAG = /^--[a-z][a-z0-9-]*$/
const SAFE_BUCK_LABEL = /^\/\/[A-Za-z0-9_./:+-]+$/

/**
 * Transform an argv vector for export: flag NAMES and syntactically-safe Buck
 * target labels pass through; every other token (flag values, paths, env-ish
 * strings, free text) is replaced. `--flag=value` forms keep only the flag
 * name.
 */
export const sanitizeArgv = ({
  argv,
  policy = defaultSanitizationPolicy,
}: {
  readonly argv: ReadonlyArray<string>
  readonly policy?: SanitizationPolicy | undefined
}): ReadonlyArray<string> =>
  argv.map((token) => {
    if (SAFE_FLAG.test(token) === true || SAFE_BUCK_LABEL.test(token) === true) {
      return token
    }
    if (token.startsWith('--') === true && token.includes('=') === true) {
      return token.slice(0, token.indexOf('=') + 1) + policy.redactedValue
    }
    return policy.redactedValue
  })

/**
 * Environment values are NEVER exported. Only the COUNT of variables survives,
 * as a bounded number — not a key list, so even private variable NAMES cannot
 * leak.
 */
export const sanitizeEnv = (env: Readonly<Record<string, string>>): { readonly count: number } => ({
  count: Object.keys(env).length,
})
