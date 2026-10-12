import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { Schema } from 'effect'

/** One authority-generated committed output with deterministic expected bytes. */
export type GeneratedArtifact = {
  readonly id: string
  readonly path: string
  readonly content: string
}
/** Ordered complete output inventory shared by generation and freshness checks. */
export type ArtifactRegistry = ReadonlyArray<GeneratedArtifact>
/** Missing or changed output and the fingerprints needed for a causal diff. */
export type ArtifactDrift = {
  readonly id: string
  readonly path: string
  readonly expectedFingerprint: string
  readonly actualFingerprint?: string
}
/** Invalid artifact identity, duplicate output, or repository-escaping path. */
export class ArtifactRegistryError extends Schema.TaggedError<ArtifactRegistryError>()(
  'ArtifactRegistryError',
  { id: Schema.String, path: Schema.String, message: Schema.String },
) {}
/** Freshness failure listing every missing or byte-different generated output. */
export class ArtifactDriftError extends Schema.TaggedError<ArtifactDriftError>()(
  'ArtifactDriftError',
  { paths: Schema.Array(Schema.String), message: Schema.String },
) {}

/** SHA-256 identity of the exact supplied bytes without a presentation prefix. */
export const fingerprint = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex')
/** Ordered inputs keep semantic and generator fingerprints distinct at their call sites. */
export const fingerprintInputs = (
  inputs: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): string => {
  const hash = createHash('sha256')
  for (const input of inputs) {
    hash.update(`${Buffer.byteLength(input.path)}:`).update(input.path)
    hash.update(`${Buffer.byteLength(input.content)}:`).update(input.content)
  }
  return hash.digest('hex')
}
/** Rejects ambiguous identities and nonportable output paths before artifact I/O. */
export const defineArtifactRegistry = <TArtifacts extends ArtifactRegistry>(
  artifacts: TArtifacts,
): TArtifacts => {
  const ids = new Set<string>(),
    paths = new Set<string>()
  for (const artifact of artifacts) {
    const normalized = artifact.path.replaceAll('\\', '/')
    if (
      !artifact.id.trim() ||
      ids.has(artifact.id) ||
      paths.has(artifact.path) ||
      isAbsolute(artifact.path) ||
      normalized.split('/').some((part) => part === '..' || !part) ||
      normalized !== artifact.path
    ) {
      throw new ArtifactRegistryError({
        id: artifact.id,
        path: artifact.path,
        message: `Invalid or duplicate generated artifact ${artifact.id}: ${artifact.path}`,
      })
    }
    ids.add(artifact.id)
    paths.add(artifact.path)
  }
  return artifacts
}
const artifactPath = ({
  repositoryRoot,
  path,
}: {
  readonly repositoryRoot: string
  readonly path: string
}): string => {
  const absolute = resolve(repositoryRoot, path)
  const local = relative(resolve(repositoryRoot), absolute)
  if (local.startsWith('..') || isAbsolute(local))
    throw new ArtifactRegistryError({
      id: '',
      path,
      message: `Artifact escapes repository: ${path}`,
    })
  return absolute
}
const readOrMissing = (path: string): Buffer | undefined => {
  try {
    return readFileSync(path)
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined
    throw cause
  }
}
/** Reports exact-byte differences without rewriting any generated output. */
export const diffArtifacts = (args: {
  readonly repositoryRoot: string
  readonly artifacts: ArtifactRegistry
}): ReadonlyArray<ArtifactDrift> => {
  defineArtifactRegistry(args.artifacts)
  return args.artifacts.flatMap((artifact) => {
    const actual = readOrMissing(
      artifactPath({ repositoryRoot: args.repositoryRoot, path: artifact.path }),
    )
    const expected = Buffer.from(artifact.content)
    if (actual?.equals(expected)) return []
    return [
      {
        id: artifact.id,
        path: artifact.path,
        expectedFingerprint: fingerprint(expected),
        ...(actual === undefined ? {} : { actualFingerprint: fingerprint(actual) }),
      },
    ]
  })
}
/** Fails when any committed output differs from its authority-generated expected bytes. */
export const checkArtifacts = (args: {
  readonly repositoryRoot: string
  readonly artifacts: ArtifactRegistry
}): void => {
  const drift = diffArtifacts(args)
  if (drift.length)
    throw new ArtifactDriftError({
      paths: drift.map(({ path }) => path),
      message: `Generated artifacts are missing or stale: ${drift.map(({ path }) => path).join(', ')}`,
    })
}
/** Unchanged writers preserve content/mtime while restoring the read-only output contract. */
export const writeArtifacts = (args: {
  readonly repositoryRoot: string
  readonly artifacts: ArtifactRegistry
}): void => {
  defineArtifactRegistry(args.artifacts)
  for (const artifact of args.artifacts) {
    const path = artifactPath({ repositoryRoot: args.repositoryRoot, path: artifact.path })
    const actual = readOrMissing(path)
    if (actual?.equals(Buffer.from(artifact.content))) {
      chmodSync(path, 0o444)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    if (actual !== undefined) chmodSync(path, 0o644)
    writeFileSync(path, artifact.content)
    chmodSync(path, 0o444)
  }
}
