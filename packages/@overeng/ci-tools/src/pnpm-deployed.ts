import { Effect, FileSystem, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'

import { pnpmDeclarationPaths } from './pnpm-declaration-paths.ts'

/** Public deployed pnpm registry. Replace the unpublished gist identifier before enabling bumps. */
export const deployedPnpmRegistryUrl =
  'https://gist.githubusercontent.com/schickling-assistant/PENDING_PUBLIC_GIST_ID/raw/pnpm-deployed.json'

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))
const Registry = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.DateTimeUtcFromString,
  pnpm: Schema.Array(Version),
})
const Manifest = Schema.Struct({ packageManager: Schema.String })

/** Fail-closed diagnostic for declarations or the public registry. */
export class PnpmRegistryError extends Schema.TaggedError<PnpmRegistryError>(
  '@overeng/ci-tools/pnpm-deployed/PnpmRegistryError',
)('PnpmRegistryError', { message: Schema.String }) {}

/** Read authoritative Genie/Nix declarations and their generated root manifest, then check deployment. */
export const checkDeployedPnpm = Effect.fn('ci-tools.check-deployed-pnpm')(function* (options: {
  readonly root: string
  readonly registryUrl: string
}) {
  const fs = yield* FileSystem.FileSystem
  const read = (path: string) => fs.readFileString(`${options.root}/${path}`)
  const genie = yield* read(pnpmDeclarationPaths[0])
  const nix = yield* read('nix/pnpm.nix')
  const manifest = yield* read('package.json').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
  )
  const declarations = [
    {
      source: pnpmDeclarationPaths[0],
      version: genie.match(
        /^const DEFAULT_AGGREGATE_PACKAGE_MANAGER = ['"]pnpm@(\d+\.\d+\.\d+)['"]$/m,
      )?.[1],
    },
    { source: 'nix/pnpm.nix', version: nix.match(/^\s*version = "(\d+\.\d+\.\d+)";$/m)?.[1] },
    {
      source: 'package.json',
      version: manifest.packageManager.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/)?.[1],
    },
  ]
  if (declarations.some(({ version }) => version === undefined)) {
    return yield* new PnpmRegistryError({
      message: `Cannot read exact pnpm declarations: ${declarations.map(({ source, version }) => `${source}=${version ?? 'invalid'}`).join(', ')}`,
    })
  }
  const versions = new Set(declarations.map(({ version }) => version))
  if (versions.size !== 1) {
    return yield* new PnpmRegistryError({
      message: `pnpm declarations disagree: ${declarations.map(({ source, version }) => `${source}=${version}`).join(', ')}`,
    })
  }
  const registry = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(options.registryUrl)
    if (response.status < 200 || response.status >= 300) {
      return yield* new PnpmRegistryError({ message: `HTTP ${response.status}` })
    }
    const text = yield* response.text
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Registry))(text)
  }).pipe(
    Effect.timeout('20 seconds'),
    Effect.mapError(
      (cause) =>
        new PnpmRegistryError({
          message: `Cannot read the deployed pnpm registry at ${options.registryUrl}: ${String(cause)}`,
        }),
    ),
  )
  const missing = [...versions].filter(
    (version) => version !== undefined && !registry.pnpm.includes(version),
  )
  if (missing.length > 0) {
    return yield* new PnpmRegistryError({
      message: `pnpm version(s) ${missing.join(', ')} are not listed in the deployed pnpm registry at ${options.registryUrl}`,
    })
  }
  yield* Effect.log(
    `pnpm ${[...versions].join(', ')} is listed in the deployed pnpm registry at ${options.registryUrl}`,
  )
})
