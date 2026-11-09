#!/usr/bin/env bun
import { appendFile, readFile } from 'node:fs/promises'

import {
  type CacheAdmissionInvocation,
  decodeCacheAdmissionInvocation,
} from './buck2-cache-evidence.ts'

/**
 * Project validated reader classifications into GitHub outputs and safe probe diagnostics.
 * Diagnostics omit pinned repeats and retain at most eight distinct failed decisions.
 */
export const collectReapiClassifications = (
  contents: string | undefined,
): { output: string; diagnostics: string; invalidRows: boolean } => {
  const reasons: Partial<
    Record<NonNullable<CacheAdmissionInvocation['phase']>, CacheAdmissionInvocation['reason']>
  > = {}
  let invalidRows = false
  const diagnostics = new Set<string>()
  for (const line of contents?.split('\n') ?? []) {
    if (line.trim().length === 0) continue
    try {
      const row = decodeCacheAdmissionInvocation(JSON.parse(line))
      if (row.phase !== undefined && row.reason !== undefined) {
        reasons[row.phase] ??= row.reason
      }
      if (
        diagnostics.size < 8 &&
        row.admissionFallbacks.reapi === 1 &&
        row.reapiDecision !== 'pinned-from-first-probe' &&
        (row.reapiDecision === 'first-probe-for-ci-job' ||
          row.reapiFailure !== undefined ||
          (row.reapiAttempts?.length ?? 0) > 0)
      ) {
        // Explicit allowlist even after decoding: never serialize the full evidence row.
        const diagnostic = {
          phase: row.phase,
          reason: row.reason,
          reapiDecision: row.reapiDecision,
          failure:
            row.reapiFailure === undefined
              ? undefined
              : { class: row.reapiFailure.class, phase: row.reapiFailure.phase },
          attempts: row.reapiAttempts?.map((attempt) => ({
            attemptIndex: attempt.attemptIndex,
            elapsedMs: attempt.elapsedMs,
            deadlineMs: attempt.deadlineMs,
            dnsResolvedMs: attempt.dnsResolvedMs,
            tcpConnectedMs: attempt.tcpConnectedMs,
            tlsReadyMs: attempt.tlsReadyMs,
            firstResponseMs: attempt.firstResponseMs,
            failure:
              attempt.failure === undefined
                ? undefined
                : { class: attempt.failure.class, phase: attempt.failure.phase },
          })),
        }
        diagnostics.add(`Buck2 REAPI admission fallback: ${JSON.stringify(diagnostic)}\n`)
      }
    } catch {
      invalidRows = true
    }
  }
  let output = ''
  for (const phase of ['admission', 'in_build'] as const) {
    if (reasons[phase] !== undefined) output += `${phase}=${reasons[phase]}\n`
  }
  return { output, diagnostics: [...diagnostics].join(''), invalidRows }
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
  const { output, diagnostics, invalidRows } = collectReapiClassifications(contents)
  if (invalidRows === true)
    console.error('Reader REAPI classification: ignored invalid sidecar rows.')
  if (diagnostics.length > 0) process.stdout.write(diagnostics)
  if (output.length > 0) await appendFile(outputPath, output)
}

if (import.meta.main) {
  await run().catch(() => {
    // Do not expose input rows, filesystem paths, or workflow commands in diagnostics.
    console.error('Reader REAPI classification: unable to read sidecar or write outputs.')
  })
}
