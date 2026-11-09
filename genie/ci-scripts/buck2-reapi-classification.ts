#!/usr/bin/env bun
import { appendFile, readFile } from 'node:fs/promises'

import {
  type CacheAdmissionInvocation,
  decodeCacheAdmissionInvocation,
} from './buck2-cache-evidence.ts'

/** Project only validated, first-per-phase reader classifications into GitHub outputs. */
export const collectReapiClassifications = (
  contents: string | undefined,
): { output: string; invalidRows: boolean } => {
  const reasons: Partial<
    Record<NonNullable<CacheAdmissionInvocation['phase']>, CacheAdmissionInvocation['reason']>
  > = {}
  let invalidRows = false
  for (const line of contents?.split('\n') ?? []) {
    if (line.trim().length === 0) continue
    try {
      const row = decodeCacheAdmissionInvocation(JSON.parse(line))
      if (row.phase !== undefined && row.reason !== undefined) {
        reasons[row.phase] ??= row.reason
      }
    } catch {
      invalidRows = true
    }
  }
  let output = ''
  for (const phase of ['admission', 'in_build'] as const) {
    if (reasons[phase] !== undefined) output += `${phase}=${reasons[phase]}\n`
  }
  return { output, invalidRows }
}

// Collection is advisory: absent sidecars and filesystem failures must not change job status.
const run = async (): Promise<void> => {
  const evidencePath = process.env.CI_BUCK2_CACHE_EVIDENCE_PATH
  const outputPath = process.env.GITHUB_OUTPUT
  if (
    evidencePath === undefined ||
    evidencePath === '' ||
    outputPath === undefined ||
    outputPath === ''
  )
    return
  let contents: string
  try {
    contents = await readFile(`${evidencePath}.admission.jsonl`, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  const { output, invalidRows } = collectReapiClassifications(contents)
  if (invalidRows === true)
    console.error('Reader REAPI classification: ignored invalid sidecar rows.')
  if (output.length > 0) await appendFile(outputPath, output)
}

if (import.meta.main) {
  await run().catch(() => {
    // Do not expose input rows, filesystem paths, or workflow commands in diagnostics.
    console.error('Reader REAPI classification: unable to read sidecar or write outputs.')
  })
}
