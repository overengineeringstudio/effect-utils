import { NodeServices } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type { Plugin } from 'vite'

import { CHANGELOG_MANIFEST_FILENAME, NonEmptyTrimmedString } from '../contract.ts'
import { PUBLISHED_SCREENSHOT_PREFIX, type ChangelogConfig } from './config.ts'
import { buildChangelog, changelogPaths } from './load.ts'

/** The fields read from the canonical `build-identity.json` (owned by `@overeng/utils`). */
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ machineVersion: NonEmptyTrimmedString })),
)

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

/**
 * Ships `changelog.v1.json` and its screenshots with every build.
 *
 * The manifest is stamped with the `machineVersion` of the build's own canonical
 * `build-identity.json` (emitted by `createBuildIdentityPlugin` from `@overeng/utils`, which must
 * run in the same build), so a waiting service-worker update carries exactly its own changelog.
 * Screenshots are emitted under `changelog/` with content-hashed names; products decide how to
 * cache them (they are meant to load lazily, not to be precached).
 *
 * In dev the same files are served from source on every request, stamped with the dev server's
 * own `/build-identity.json`.
 */
export const changelogVitePlugin = <Text, Fields>(
  config: ChangelogConfig<Text, Fields>,
  {
    unrendered = 'fail',
  }: {
    /** `omit` while the renderer drives this build: unrendered screenshots are left out. */
    readonly unrendered?: 'fail' | 'omit' | undefined
  } = {},
): Plugin => ({
  name: 'overeng:changelog',
  enforce: 'post',
  async buildStart() {
    // Validate early and watch the entries so `vite build --watch` rebuilds on edits.
    const { directory } = await run(changelogPaths(config))
    this.addWatchFile(directory)
  },
  generateBundle: {
    order: 'post',
    async handler(_options, bundle) {
      const identity = bundle['build-identity.json']
      if (identity?.type !== 'asset' || typeof identity.source !== 'string') {
        this.error('changelog: the build must include the canonical build-identity.json')
      }
      const { machineVersion } = decodeIdentity(identity.source)
      const { bytes, assets } = await run(buildChangelog({ config, machineVersion, unrendered }))
      this.emitFile({ type: 'asset', fileName: CHANGELOG_MANIFEST_FILENAME, source: bytes })
      for (const asset of assets) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.bytes })
      }
    },
  },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = request.url?.split('?')[0] ?? ''
      const manifest = url.endsWith(`/${CHANGELOG_MANIFEST_FILENAME}`)
      const screenshot = url.includes(`/${PUBLISHED_SCREENSHOT_PREFIX}`) && url.endsWith('.png')
      if ((manifest === false && screenshot === false) || request.method !== 'GET') {
        next()
        return
      }
      void (async () => {
        const origin = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`
        const identity = await fetch(new URL('build-identity.json', origin))
        const { machineVersion } = decodeIdentity(await identity.text())
        const built = await run(buildChangelog({ config, machineVersion, unrendered: 'omit' }))
        if (manifest === true) {
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-cache',
          })
          response.end(built.bytes)
          return
        }
        const asset = built.assets.find((candidate) => url.endsWith(`/${candidate.fileName}`))
        if (asset === undefined) {
          next()
          return
        }
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' })
        response.end(asset.bytes)
      })().catch(next)
    })
  },
})
