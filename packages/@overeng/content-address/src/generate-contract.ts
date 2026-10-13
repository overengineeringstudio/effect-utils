import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import type { PlatformError } from 'effect/PlatformError'

import { compile } from '@overeng/effect-rust/compiler'

import { Codec, ContentDescriptor, ContentDigest, MediaType, NonNegativeInt } from './schema.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const contractPath = 'rust/content-address-contract'
const root = `${repoRoot}${contractPath}/`
const manifestPath = 'generation.json'
const command = 'bun packages/@overeng/content-address/src/generate-contract.ts'
const sourceDirectories = [
  'packages/@overeng/effect-rust/src/compiler',
  'packages/@overeng/effect-rust/src/schema',
]
const sourcePaths = [
  'packages/@overeng/content-address/src/generate-contract.ts',
  'packages/@overeng/content-address/src/schema.ts',
  'packages/@overeng/effect-rust/src/mod.ts',
  'pnpm-lock.yaml',
  'flake.lock',
  'rust/Cargo.toml',
  'rust/Cargo.lock',
]

const HashEntry = Schema.Struct({
  path: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const GenerationManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  inputFingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  generatedAt: Schema.String.check(
    Schema.makeFilter(
      (value: string) =>
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
      { description: 'canonical ISO generation timestamp' },
    ),
  ),
  runtime: Schema.Struct({ name: Schema.Literal('bun'), version: Schema.Literal('1.4.2') }),
  inputs: Schema.Array(HashEntry),
  artifacts: Schema.Array(HashEntry),
})

class ContractGenerationError extends Schema.TaggedError<ContractGenerationError>()(
  'ContractGenerationError',
  { message: Schema.String, paths: Schema.Array(Schema.String) },
) {}

const sha256 = ({ content }: { readonly content: string | Uint8Array }): string =>
  createHash('sha256').update(content).digest('hex')

// The freshness authority uses this exact compact JSON byte protocol, not a
// schema encoder whose object ordering could change the shared fingerprint.
const fingerprint = ({
  runtime,
  inputs,
}: {
  readonly runtime: typeof GenerationManifest.Type.runtime
  readonly inputs: typeof GenerationManifest.Type.inputs
}): string => `sha256:${sha256({ content: JSON.stringify({ schemaVersion: 1, runtime, inputs }) })}`

// The scope is deliberately named, not the ambient package tree. Tests and
// snapshots cannot affect generation; new compiler/schema source files can.
const collectSources = Effect.fn('ContentAddress.collectContractSources')(function* ({
  directory,
}: {
  readonly directory: string
}) {
  const fs = yield* FileSystem.FileSystem
  const paths: string[] = []
  const visit = Effect.fn('ContentAddress.visitContractSources')(function* ({
    path,
  }: {
    readonly path: string
  }): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem> {
    for (const entry of (yield* fs.readDirectory(`${repoRoot}${path}`)).toSorted()) {
      const child = `${path}/${entry}`
      const info = yield* fs.stat(`${repoRoot}${child}`)
      if (info.type === 'Directory') yield* visit({ path: child })
      else if (
        info.type === 'File' &&
        child.endsWith('.ts') === true &&
        child.endsWith('.test.ts') === false
      )
        paths.push(child)
    }
  })
  yield* visit({ path: directory })
  return paths
})

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const args = process.argv.slice(2)
    if (args.some((arg) => arg !== '--check') === true || args.length > 1)
      return yield* new ContractGenerationError({
        message: `Usage: ${command} [--check]`,
        paths: [],
      })
    const check = args.includes('--check')
    const version = process.versions.bun
    if (version !== '1.4.2')
      return yield* new ContractGenerationError({
        message: `Contract generation requires Bun 1.4.2; found ${version ?? 'non-Bun runtime'}`,
        paths: [],
      })
    // Record the actual runtime only after verifying the repository's pinned version.
    const runtime = { name: 'bun' as const, version }
    const inputs = []
    const paths = [...sourcePaths]
    for (const directory of sourceDirectories) paths.push(...(yield* collectSources({ directory })))
    for (const path of paths.toSorted()) {
      const content = yield* fs.readFile(`${repoRoot}${path}`)
      inputs.push({ path, sha256: sha256({ content }) })
    }
    const inputFingerprint = fingerprint({ runtime, inputs })
    const manifestTarget = `${root}${manifestPath}`
    const previous =
      (yield* fs.exists(manifestTarget)) === true
        ? yield* Schema.decodeEffect(Schema.fromJsonString(GenerationManifest))(
            yield* fs.readFileString(manifestTarget),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ContractGenerationError({
                  message: `Invalid ${contractPath}/${manifestPath}: ${cause}`,
                  paths: [`${contractPath}/${manifestPath}`],
                }),
            ),
          )
        : undefined
    const generatedAt =
      previous !== undefined && (check === true || previous.inputFingerprint === inputFingerprint)
        ? previous.generatedAt
        : new Date().toISOString()
    const provenance = [
      'Generated contract; DO NOT EDIT BY HAND.',
      `Provenance: ${contractPath}/${manifestPath}`,
      `Regenerate: ${command}`,
      `Input fingerprint: ${inputFingerprint}`,
      `Generated at: ${generatedAt}`,
    ]
    const generated = compile(
      { ContentDescriptor, ContentDigest, MediaType, Codec, NonNegativeInt },
      {
        crateName: 'content-address-contract',
        schemaMetadata: 'schemars',
        cargo: {
          mode: 'workspace',
          workspace: '..',
          inherit: ['version', 'edition', 'license'],
          dependencies: 'workspace',
        },
      },
    )
    const files: Record<string, string> = Object.fromEntries(
      Object.entries(generated.files).filter(([path]) => path.startsWith('effect/') === false),
    )
    // JSON Schema cannot carry comments: generation.json owns its provenance.
    // Rust/TOML use native comments in addition to the enclosing manifest.
    for (const [path, content] of Object.entries(files)) {
      const prefix =
        path.endsWith('.rs') === true ? '//' : path.endsWith('.toml') === true ? '#' : undefined
      const source =
        prefix === undefined
          ? content
          : `${provenance.map((line) => `${prefix} ${line}`).join('\n')}\n${content}`
      files[path] =
        path.endsWith('.rs') === true
          ? yield* Effect.try({
              try: () =>
                execFileSync('rustfmt', ['--edition', '2021', '--emit', 'stdout'], {
                  input: source,
                  encoding: 'utf8',
                }),
              catch: (cause) =>
                new ContractGenerationError({
                  message: `Formatting ${contractPath}/${path} failed: ${cause}`,
                  paths: [`${contractPath}/${path}`],
                }),
            })
          : source
    }
    const artifacts = Object.entries(files)
      .map(([path, content]) => ({ path, sha256: sha256({ content }) }))
      .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    // The manifest is added only after artifact hashes, never hashing itself.
    files[manifestPath] =
      (yield* Schema.encodeEffect(Schema.fromJsonString(GenerationManifest, { space: 2 }))({
        schemaVersion: 1,
        inputFingerprint,
        generatedAt,
        runtime,
        inputs,
        artifacts,
      })) + '\n'
    const mismatches: string[] = []
    for (const [path, content] of Object.entries(files)) {
      const target = `${root}${path}`
      const exists = yield* fs.exists(target)
      const unchanged = exists === true && (yield* fs.readFileString(target)) === content
      if (check === true) {
        if (unchanged === false)
          mismatches.push(`${contractPath}/${path}: missing or different bytes`)
        else if (((yield* fs.stat(target)).mode & 0o222) !== 0)
          mismatches.push(`${contractPath}/${path}: generated output is writable`)
        continue
      }
      if (unchanged === false) {
        yield* fs.makeDirectory(target.slice(0, target.lastIndexOf('/')), { recursive: true })
        // Keep the writable window uninterruptible and restore protection on failure.
        // No generated output needs to remain writable between generator runs.
        yield* Effect.gen(function* () {
          if (exists === true) yield* fs.chmod(target, 0o644)
          yield* fs.writeFileString(target, content, { mode: 0o444 })
        }).pipe(Effect.ensuring(fs.chmod(target, 0o444).pipe(Effect.orDie)), Effect.uninterruptible)
      } else if (((yield* fs.stat(target)).mode & 0o222) !== 0) {
        // Git does not preserve read-only bits; repair checkout permissions without rewriting.
        yield* fs.chmod(target, 0o444)
      }
    }
    if (mismatches.length > 0)
      return yield* new ContractGenerationError({
        message: `Contract generation is stale:\n${mismatches.join('\n')}`,
        paths: mismatches,
      })
  }).pipe(Effect.provide(NodeServices.layer)),
)
