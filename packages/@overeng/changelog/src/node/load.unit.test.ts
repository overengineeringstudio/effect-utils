import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { makeChangelogContract, NonEmptyTrimmedString } from '../contract.ts'
import type { ChangelogConfig } from './config.ts'
import { buildChangelog, discoverEntries, screenshotHash } from './load.ts'

const contract = makeChangelogContract({
  product: 'demo',
  text: NonEmptyTrimmedString,
  fields: { area: Schema.Literals(['board', 'chat']) },
})

const theme = {
  ink: '#000',
  badgeFill: '#ff0',
  badgeInk: '#000',
  captionInk: '#000',
  captionHalo: '#fff',
  highlight: '#ff0',
  fontFamily: 'sans-serif',
}

const makeProduct = Effect.fn(function* (files: Readonly<Record<string, string | Uint8Array>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped()
  for (const [file, content] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
    yield* typeof content === 'string'
      ? fs.writeFileString(path.join(root, file), content)
      : fs.writeFile(path.join(root, file), content)
  }
  const config: ChangelogConfig<string, { readonly area: 'board' | 'chat' }> = {
    contract,
    root,
    sourcePaths: ['src/**'],
    screenshots: {
      viewports: [{ name: 'phone', width: 390, height: 844, deviceScaleFactor: 2 }],
      schemes: ['light'],
      themes: { light: theme, dark: theme },
      inputs: ['shared/**'],
      renderText: (text) => text,
    },
  }
  return { root, config }
})

const plain = `export const entry = { title: 'Chat', summary: 'Talk while you play.', area: 'chat' }\n`
const pictured = `export const entry = {
  title: 'Board',
  summary: 'A new board.',
  area: 'board',
  screenshot: {
    alt: 'The board',
    crop: { target: '#board' },
    annotations: [{ kind: 'ring', n: 1, target: '#cell', caption: 'This cell' }],
    inputs: ['src/board/**'],
  },
}\n`

describe('changelog loading', () => {
  it.effect('discovers entries strictly and pairs scenes with screenshot entries', () =>
    Effect.gen(function* () {
      const { config } = yield* makeProduct({
        '.changelog/2026-11-20-chat.ts': plain,
        '.changelog/2026-11-22-board.ts': pictured,
        '.changelog/2026-11-22-board.scene.ts': 'export const scene = async () => {}\n',
      })
      const entries = yield* discoverEntries(config)
      expect(entries.map((entry) => entry.id)).toEqual(['2026-11-20-chat', '2026-11-22-board'])

      const orphan = yield* makeProduct({
        '.changelog/2026-11-20-chat.ts': plain,
        '.changelog/2026-11-20-chat.scene.ts': 'export const scene = 1\n',
      })
      const error = yield* Effect.flip(discoverEntries(orphan.config))
      expect(error.message).toContain('declares no screenshot')

      const misnamed = yield* makeProduct({ '.changelog/chat.ts': plain })
      expect((yield* Effect.flip(discoverEntries(misnamed.config))).message).toContain(
        'YYYY-MM-DD-slug.ts',
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('hashes the entry, scene and declared inputs, nothing else', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { root, config } = yield* makeProduct({
        '.changelog/2026-11-22-board.ts': pictured,
        '.changelog/2026-11-22-board.scene.ts': 'export const scene = async () => {}\n',
        'src/board/Board.tsx': 'board v1',
        'src/chat/Chat.tsx': 'chat v1',
        'shared/helpers.ts': 'helpers v1',
      })
      const hash = Effect.flatMap(discoverEntries(config), ([entry]) =>
        screenshotHash({ config, entry: entry! }),
      )
      const first = yield* hash
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
      yield* fs.writeFileString(path.join(root, 'src/chat/Chat.tsx'), 'chat v2')
      expect(yield* hash).toBe(first)
      yield* fs.writeFileString(path.join(root, 'src/board/Board.tsx'), 'board v2')
      const second = yield* hash
      expect(second).not.toBe(first)
      yield* fs.writeFileString(path.join(root, 'shared/helpers.ts'), 'helpers v2')
      expect(yield* hash).not.toBe(second)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('builds a stamped manifest with content-hashed screenshot assets', () =>
    Effect.gen(function* () {
      const png = new Uint8Array([137, 80, 78, 71])
      const { config } = yield* makeProduct({
        '.changelog/2026-11-20-chat.ts': plain,
        '.changelog/2026-11-22-board.ts': pictured,
        '.changelog/2026-11-22-board.scene.ts': 'export const scene = async () => {}\n',
        '.changelog/screenshots/2026-11-22-board.json': JSON.stringify({
          hash: 'sha256:x',
          images: [
            { viewport: 'phone', scheme: 'light', file: '2026-11-22-board-phone-light.png', width: 390, height: 240 },
          ],
        }),
        '.changelog/screenshots/2026-11-22-board-phone-light.png': png,
      })
      const built = yield* buildChangelog({ config, machineVersion: '0.1.0+abc1234' })
      expect(built.manifest.build).toEqual({ machineVersion: '0.1.0+abc1234' })
      expect(built.manifest.entries.map((entry) => entry.id)).toEqual([
        '2026-11-22-board',
        '2026-11-20-chat',
      ])
      expect(built.assets).toHaveLength(1)
      const [asset] = built.assets
      expect(asset!.fileName).toMatch(/^changelog\/2026-11-22-board-phone-light\.[0-9a-f]{10}\.png$/)
      expect(built.manifest.entries[0]!.screenshot).toEqual({
        alt: 'The board',
        images: [{ viewport: 'phone', scheme: 'light', src: `./${asset!.fileName}`, width: 390, height: 240 }],
        callouts: [{ n: 1, caption: 'This cell' }],
      })
      expect(contract.decodeManifest(JSON.parse(built.bytes))).toEqual(built.manifest)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('fails the build when a screenshot entry was never rendered', () =>
    Effect.gen(function* () {
      const { config } = yield* makeProduct({
        '.changelog/2026-11-22-board.ts': pictured,
        '.changelog/2026-11-22-board.scene.ts': 'export const scene = async () => {}\n',
      })
      const error = yield* Effect.flip(buildChangelog({ config, machineVersion: 'v' }))
      expect(error.message).toContain('none is rendered')
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
