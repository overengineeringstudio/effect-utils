import {
  checkArtifacts,
  diffArtifacts,
  writeArtifacts,
  type ArtifactRegistry,
} from './artifact-registry.ts'

/** Supported committed-output authoring and freshness operations. */
export type RegistryCommand = 'generate' | 'check' | 'diff'
/** Authority-local entrypoints supply the complete generated inventory; no global mutable registry. */
export const runRegistryCli = (args: {
  readonly argv: ReadonlyArray<string>
  readonly repositoryRoot: string
  readonly artifacts: ArtifactRegistry
  readonly output?: (text: string) => void
}): number => {
  const command = args.argv[0]
  if (
    args.argv.length !== 1 ||
    (command !== 'generate' && command !== 'check' && command !== 'diff')
  ) {
    throw new TypeError('Usage: schema-registry generate|check|diff')
  }
  if (command === 'generate') {
    writeArtifacts(args)
    return 0
  }
  if (command === 'check') {
    checkArtifacts(args)
    return 0
  }
  const drift = diffArtifacts(args)
  for (const artifact of drift)
    args.output?.(
      `${artifact.path}: ${artifact.actualFingerprint ?? 'missing'} -> ${artifact.expectedFingerprint}`,
    )
  return drift.length ? 1 : 0
}
