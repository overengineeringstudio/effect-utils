import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defineArtifactRegistry,
  fingerprintInputs,
  runRegistryCli,
  type ArtifactRegistry,
} from '@schickling/schema-registry'
import { Schema, SchemaRepresentation as Representation } from 'effect'

import { footerV4, trailerV2 } from './bindings.ts'
import { lowerView } from './projection.ts'
import { jsonSchemaOptions, assertJsonPatternExports } from './registry.ts'
import { AgentTraceRuntimeV1, AgentTraceV2 } from './schema.ts'
const root = fileURLToPath(new URL('../', import.meta.url))
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
/** Deterministic inventory of committed audience and binding projection contracts. */
export const viewSpecs = (['public-minimal', 'private-rich'] as const).flatMap((audience) =>
  (['Audience', 'Trailer', 'Footer'] as const).map((kind) => ({
    audience,
    kind,
    name: `${audience === 'public-minimal' ? 'Public' : 'Private'}${kind}V2`,
    binding: kind === 'Audience' ? undefined : kind === 'Trailer' ? trailerV2 : footerV4,
  })),
)
/** Computes deterministic native-printer TypeScript and strict JSON Schema artifacts. */
export const generatedSources = (): Record<string, string> => {
  const inputPaths = [
    'src/schema.ts',
    'src/bindings.ts',
    'src/projection.ts',
    'src/generator.ts',
    'src/registry.ts',
    '../schema-registry/rust/Cargo.toml',
    '../schema-registry/rust/src/lib.rs',
    '../schema-registry/rust/src/numbers.rs',
    '../schema-registry/rust/src/runtime.rs',
    '../schema-registry/rust/src/bin/schema-registry-rust.rs',
    'rust/Cargo.lock',
    'package.json',
    '../../.oxfmtrc.json',
  ]
  const formatterVersion = spawnSync('oxfmt', ['--version'], { encoding: 'utf8', cwd: root })
  if (formatterVersion.error || formatterVersion.status !== 0)
    throw new TypeError('Cannot fingerprint the generated-output formatter')
  const hash = fingerprintInputs([
    ...inputPaths.map((path) => ({ path, content: readFileSync(root + path, 'utf8') })),
    { path: 'tool/oxfmt-version', content: formatterVersion.stdout.trim() },
  ])
  const sources: Record<string, string> = {}
  for (const spec of viewSpecs) {
    const view = lowerView({ audience: spec.audience, binding: spec.binding })
    assertJsonPatternExports(view.schema)
    const representation = Representation.toCodeDocument(
      Representation.toMultiDocument(
        Schema.toRepresentation(view.schema, { referencePolicy: () => undefined }),
      ),
    )
    // Native printing also includes imports for its standalone type expression.
    // We emit the runtime schema and a typeof alias, so its type-only Brand
    // import is deliberately excluded rather than emitted unused.
    const imports = representation.artifacts.flatMap((a) =>
      a._tag === 'Import' &&
      !/^import\s+type\b/.test(a.importDeclaration) &&
      !a.importDeclaration.includes('type Brand')
        ? [a.importDeclaration]
        : [],
    )
    if (
      representation.artifacts.some((a) => a._tag !== 'Import') ||
      representation.references.nonRecursives.length ||
      Object.keys(representation.references.recursives).length
    )
      throw new TypeError('Unsupported printer reference')
    sources[`${spec.name}.ts`] =
      `// Generated; do not edit. Inputs: ${inputPaths.join(', ')}; Effect 4.0.0.\n// Regenerate: pnpm run generate; sha256=${hash}\nimport { Schema } from 'effect'\n${imports.join('\n')}\nimport type { Plan } from '../src/projection.ts'\n/** Generated ${spec.audience} ${spec.binding?.version ?? 'audience'} view of agent-trace/v2. */\nexport const ${spec.name} = ${representation.codes[0]!.runtime}.pipe(Schema.brand('${spec.name}'))\n/** Decoded branded type of the generated view. */\nexport type ${spec.name} = typeof ${spec.name}.Type\n/** Generated portable coarsening and restriction plan. */\nexport const plan = ${json(view.plan)} satisfies Plan\n`
    const document = Schema.toJsonSchemaDocument(view.schema, jsonSchemaOptions)
    sources[`${spec.name}.schema.json`] =
      json({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: `agent-trace/v2/${spec.audience}/${spec.binding?.version ?? 'audience'}`,
        $comment: `Generated; do not edit; pnpm run generate; sha256=${hash}; Effect 4.0.0`,
        title: spec.name,
        ...document.schema,
        $defs: document.definitions,
      }) + '\n'
  }
  assertJsonPatternExports(AgentTraceV2)
  const semantic = Schema.toJsonSchemaDocument(AgentTraceV2, jsonSchemaOptions)
  sources['AgentTraceV2.schema.json'] =
    json({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'agent-trace/v2',
      $comment: `Generated; do not edit; pnpm run generate; sha256=${hash}; Effect 4.0.0`,
      ...semantic.schema,
      $defs: semantic.definitions,
    }) + '\n'
  assertJsonPatternExports(AgentTraceRuntimeV1)
  const runtime = Schema.toJsonSchemaDocument(AgentTraceRuntimeV1, jsonSchemaOptions)
  const runtimeSchema = json({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'agent-trace-runtime/v1',
    $comment: `Generated; do not edit; pnpm run generate; sha256=${hash}; Effect 4.0.0`,
    ...runtime.schema,
    $defs: runtime.definitions,
  })
  sources['AgentTraceRuntimeV1.schema.json'] = runtimeSchema + '\n'
  // The reusable Rust generator emits a fully standalone module; downstream
  // repositories can vendor this file with serde, serde_json and regex only.
  const standalone = spawnSync(
    'cargo',
    [
      'run',
      '--locked',
      '--quiet',
      '--manifest-path',
      '../schema-registry/rust/Cargo.toml',
      '-p',
      'schema-registry-rust',
      '--bin',
      'schema-registry-rust',
      '--',
      'AgentTraceRuntimeV1',
    ],
    { cwd: root, encoding: 'utf8', input: runtimeSchema },
  )
  if (standalone.error || standalone.status !== 0)
    throw new TypeError(
      `Standalone runtime Rust generation failed: ${standalone.error?.message ?? standalone.stderr}`,
    )
  sources['AgentTraceRuntimeV1.rs'] =
    `// Generated; do not edit. Inputs: ${inputPaths.join(', ')}.\n// Regenerate: pnpm run generate; sha256=${hash}\n` +
    standalone.stdout
  return Object.fromEntries(
    Object.entries(
      formatArtifacts(
        Object.fromEntries(
          Object.entries(sources).map(([name, content]) => ['generated/' + name, content]),
        ),
      ),
    ).map(([path, content]) => [path.slice('generated/'.length), content]),
  )
}
/** Complete deterministic inventory consumed by shared generation, freshness and diff operations. */
export const generatedArtifacts = (): ArtifactRegistry =>
  defineArtifactRegistry(
    Object.entries(generatedSources()).map(([name, content]) => ({
      id: `agent-trace/${name}`,
      path: `generated/${name}`,
      content,
    })),
  )
/** Formats all artifacts in one formatter process, preserving the canonical repository byte policy. */
export const formatArtifacts = (
  sources: Readonly<Record<string, string>>,
): Record<string, string> => {
  const entries = Object.entries(sources)
  if (!entries.length) return {}
  const scratch = mkdtempSync(join(tmpdir(), 'agent-trace-format-'))
  try {
    const paths = entries.map(([relativePath, content]) => {
      const path = join(scratch, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return path
    })
    // An explicit config keeps scratch location from affecting canonical formatting.
    // Small artifact batches use one worker rather than competing with the surrounding gate's CPU pool.
    const formatted = spawnSync(
      'oxfmt',
      [
        '--threads',
        '1',
        '--config',
        root + '../../.oxfmtrc.json',
        ...paths.filter((path) => !path.endsWith('.rs')),
      ],
      {
        encoding: 'utf8',
        cwd: root,
      },
    )
    if (formatted.error || formatted.status !== 0)
      throw new TypeError(
        `Formatting generated artifacts failed: ${formatted.error?.message ?? formatted.stderr}`,
      )
    return Object.fromEntries(
      entries.map(([relativePath], index) => [relativePath, readFileSync(paths[index]!, 'utf8')]),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = runRegistryCli({
    argv: process.argv.slice(2),
    repositoryRoot: root,
    get artifacts() {
      return generatedArtifacts()
    },
    output: console.log,
  })
