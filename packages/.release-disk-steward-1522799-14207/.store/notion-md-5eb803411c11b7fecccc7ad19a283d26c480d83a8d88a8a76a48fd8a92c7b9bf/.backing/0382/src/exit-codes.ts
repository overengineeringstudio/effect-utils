import { Cause, Exit } from 'effect'

/**
 * Editor-surface exit-code contract (VRS "Exit codes and error model").
 *
 * Each expected tagged failure maps to a distinct process exit code so `cat` /
 * `put` / `edit` are scriptable. The map is applied at the outermost runtime
 * boundary (the `runMain` teardown), after every scope/finalizer has closed —
 * never via `process.exit()` mid-effect, which would bypass `edit`'s temp-dir
 * cleanup.
 *
 * | Exit | Tag                                         |
 * | ---- | ------------------------------------------- |
 * | 0    | success                                     |
 * | 1    | NmdGatewayError                             |
 * | 2    | (CLI framework — bad flags/args)            |
 * | 3    | NmdRemoteBodyLossyError                     |
 * | 4    | NmdUnresolvablePageError                    |
 * | 5    | NmdInvalidDocumentError                     |
 * | 6    | NmdSchemaDriftError                         |
 * | 7    | NotionMdBodyConflictError / NmdConflictError |
 * | 8    | NmdEditorAbortedError                       |
 * | 9    | NmdPostPushGateError                        |
 * | 10   | NmdPartialWriteError                        |
 */
export const EDITOR_EXIT_CODES: Readonly<Record<string, number>> = {
  NmdGatewayError: 1,
  NmdRemoteBodyLossyError: 3,
  NmdUnresolvablePageError: 4,
  NmdInvalidDocumentError: 5,
  // Exit 6: data-source schema drift detected by the engine `schema_snapshot`
  // comparison before a property write (`edit --frontmatter` / file `sync`;
  // R14, decision 0017). Distinct from the exit-7 conflict — not `--force`-able.
  NmdSchemaDriftError: 6,
  NotionMdBodyConflictError: 7,
  NmdConflictError: 7,
  NmdEditorAbortedError: 8,
  NmdPostPushGateError: 9,
  NmdPartialWriteError: 10,
}

const taggedExitCode = (value: unknown): number | undefined => {
  if (typeof value !== 'object' || value === null || '_tag' in value === false) return undefined
  const tag = (value as { readonly _tag?: unknown })._tag
  return typeof tag === 'string' ? EDITOR_EXIT_CODES[tag] : undefined
}

/**
 * Map an `Exit` to a process exit code per the editor-surface contract.
 *
 * Success → 0. A tagged expected failure → its mapped code. Interruption (Ctrl+C)
 * → 130. Any other failure (defect, unmapped error) → 1, matching the
 * framework's default "something failed" code without masking the distinct
 * editor codes.
 */
export const editorExitCode = (exit: Exit.Exit<unknown, unknown>): number => {
  if (Exit.isSuccess(exit) === true) return 0
  if (Cause.hasInterruptsOnly(exit.cause) === true) return 130

  const fail = Cause.findFail(exit.cause)
  if (fail._tag === 'Success') {
    const code = taggedExitCode(fail.success.error)
    if (code !== undefined) return code
  }
  return 1
}
