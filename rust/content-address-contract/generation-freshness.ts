import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Data, Schema } from 'effect'

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}(?![\s\S])/))
const RelativePath = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      value.length > 0 &&
      value.includes('\\') === false &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      /^[A-Za-z]:/.test(value) === false,
  ),
)
const Entry = Schema.Struct({ path: RelativePath, sha256: Digest })
const GenerationManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  inputFingerprint: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}(?![\s\S])/)),
  generatedAt: Schema.String.check(
    Schema.makeFilter((value: string) => {
      const timestamp = Date.parse(value)
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    }),
  ),
  runtime: Schema.Struct({ name: Schema.Literal('bun'), version: Schema.Literal('1.4.2') }),
  inputs: Schema.Array(Entry),
  artifacts: Schema.Array(Entry),
}).annotate({ identifier: 'ContentAddressContract.GenerationManifest' })

class GenerationFreshnessError extends Data.TaggedError('GenerationFreshnessError')<{
  readonly message: string
}> {}

const fail = ({ message }: { readonly message: string }): never => {
  throw new GenerationFreshnessError({
    message: `Generated content-address contract is stale: ${message}. Regenerate with bun packages/@overeng/content-address/src/generate-contract.ts`,
  })
}
const hash = ({ content }: { readonly content: string }): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

const scopedFile = ({
  root,
  relative,
}: {
  readonly root: string
  readonly relative: string
}): string => {
  const absolute = realpathSync(path.join(root, relative))
  const resolvedRoot = realpathSync(root)
  if (absolute.startsWith(`${resolvedRoot}${path.sep}`) === false) {
    fail({ message: `path escapes its declared scope: ${relative}` })
  }
  return absolute
}

const sourcePaths = ({
  root,
  relative,
}: {
  readonly root: string
  readonly relative: string
}): string[] =>
  readdirSync(scopedFile({ root, relative }), { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`
    if (entry.isSymbolicLink() === true)
      fail({ message: `symlink in generated source inventory: ${child}` })
    if (entry.isDirectory() === true) return sourcePaths({ root, relative: child })
    return entry.isFile() === true &&
      child.endsWith('.ts') === true &&
      child.endsWith('.test.ts') === false
      ? [child]
      : []
  })

const verifyEntries = ({
  root,
  entries,
  required,
  label,
}: {
  readonly root: string
  readonly entries: readonly (typeof Entry.Type)[]
  readonly required: readonly string[]
  readonly label: string
}): void => {
  const declared = new Set<string>()
  let previous: string | undefined
  for (const entry of entries) {
    if (previous !== undefined && previous >= entry.path)
      fail({ message: `${label} must be uniquely sorted by path` })
    previous = entry.path
    declared.add(entry.path)
    const actual = hash({
      content: readFileSync(scopedFile({ root, relative: entry.path }), 'utf8'),
    })
    if (actual !== entry.sha256) fail({ message: `${label} hash mismatch: ${entry.path}` })
  }
  for (const requiredPath of required) {
    if (declared.has(requiredPath) === false)
      fail({ message: `missing ${label} provenance: ${requiredPath}` })
  }
}

/** Validate committed compiler provenance and bytes before the ordinary Cargo Buck projection renders. */
export const assertContractGenerationFreshness = ({
  sourceUrl,
}: {
  readonly sourceUrl: string
}): void => {
  const contractRoot = path.dirname(fileURLToPath(sourceUrl))
  const repoRoot = path.resolve(contractRoot, '../..')
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(GenerationManifest), {
    onExcessProperty: 'error',
  })(readFileSync(path.join(contractRoot, 'generation.json'), 'utf8'))
  const requiredInputs = [
    'packages/@overeng/content-address/src/generate-contract.ts',
    'packages/@overeng/content-address/src/schema.ts',
    'packages/@overeng/effect-rust/src/mod.ts',
    'pnpm-lock.yaml',
    'rust/Cargo.toml',
    'rust/Cargo.lock',
    ...sourcePaths({ root: repoRoot, relative: 'packages/@overeng/effect-rust/src/compiler' }),
    ...sourcePaths({ root: repoRoot, relative: 'packages/@overeng/effect-rust/src/schema' }),
  ]
  verifyEntries({
    root: repoRoot,
    entries: manifest.inputs,
    required: requiredInputs,
    label: 'input',
  })
  const fingerprint = `sha256:${hash({
    content: JSON.stringify({
      schemaVersion: 1,
      runtime: { name: manifest.runtime.name, version: manifest.runtime.version },
      inputs: manifest.inputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    }),
  })}`
  if (fingerprint !== manifest.inputFingerprint)
    fail({ message: 'inputFingerprint disagrees with canonical provenance' })

  const artifacts = new Set<string>()
  const discoverArtifacts = ({ relative }: { readonly relative: string }): void => {
    for (const entry of readdirSync(path.join(contractRoot, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.name === 'target' || entry.name.startsWith('.') === true) continue
      if (entry.isSymbolicLink() === true)
        fail({ message: `symlink in generated artifact inventory: ${child}` })
      if (entry.isDirectory() === true) discoverArtifacts({ relative: child })
      else if (child !== 'generation.json' && /\.(rs|json|toml)$/.test(child) === true)
        artifacts.add(child)
    }
  }
  discoverArtifacts({ relative: '' })
  for (const artifact of manifest.artifacts) {
    if (artifacts.has(artifact.path) === false)
      fail({ message: `not a generated Rust/JSON/Cargo artifact: ${artifact.path}` })
  }
  verifyEntries({
    root: contractRoot,
    entries: manifest.artifacts,
    required: [...artifacts, 'Cargo.toml', 'src/lib.rs', 'schema/ContentDescriptor.json'],
    label: 'artifact',
  })
}
