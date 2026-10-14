import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'

import {
  decodeActionArtifact,
  field,
  list,
  text,
} from './buck2-action-evidence-codec.ts'
import {
  auditNativeRustCacheAdmission,
  maxActionArtifactBytes,
  type NativeRustCohortManifest,
} from './buck2-action-evidence.ts'

/** The producer is an independent graph analysis, not a filter over observed cache outcomes. */
export const decodeNativeRustCohortManifest = (value: unknown): NativeRustCohortManifest => {
  if (field({ value, key: 'schemaVersion' }) !== 1)
    throw new Error('Invalid native Rust cohort manifest')
  return {
    headSha: text(field({ value, key: 'headSha' })),
    actions: list(field({ value, key: 'actions' })).map((action) => ({
      targetTriple: text(field({ value: action, key: 'targetTriple' })),
      commandKind: text(field({ value: action, key: 'commandKind' })),
      target: text(field({ value: action, key: 'target' })),
      configuration: text(field({ value: action, key: 'configuration' })),
      digest: text(field({ value: action, key: 'digest' })),
    })),
  }
}

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      actions: { type: 'string' },
      manifest: { type: 'string' },
      output: { type: 'string' },
    },
  })
  if (values.actions === undefined || values.manifest === undefined)
    throw new Error('Expected --actions <cohort-q33.jsonl.gz> --manifest <analyzed-cohort.json>')
  const compressed = new Uint8Array(await Bun.file(values.actions).arrayBuffer())
  const artifact = decodeActionArtifact(
    gunzipSync(compressed, { maxOutputLength: maxActionArtifactBytes }).toString('utf8'),
  )
  const manifest = decodeNativeRustCohortManifest(await Bun.file(values.manifest).json())
  const violations = auditNativeRustCacheAdmission({ artifact, manifest })
  const report = {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    headSha: artifact.header.metadata.headSha,
    actionCount: artifact.actions.length,
    violations,
  }
  const serialized = `${JSON.stringify(report)}\n`
  if (values.output === undefined) process.stdout.write(serialized)
  else await Bun.write(values.output, serialized)
  if (violations.length !== 0) process.exitCode = 1
}

if (import.meta.main)
  await run().catch(() => {
    // Paths and native payloads are deliberately absent from the failure surface.
    console.error('Native Rust admission audit failed: invalid arguments or evidence.')
    process.exitCode = 1
  })
