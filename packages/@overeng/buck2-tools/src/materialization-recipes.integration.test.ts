/* eslint-disable no-await-in-loop -- Ordered native consumers and real filesystem clock/handshake conditions. */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  acquireExistingEditorViewLeaseUnderFence,
  probeEditorViewLease,
} from './editor-view-leases.ts'
import { collectEditorViewContentStore } from './editor-view-sharing.ts'
import { editorViewTestDataRoot } from './editor-view-test-filesystem.ts'
import { acquireSharedArchive, maintainArchiveContent } from './materialization-archives.ts'
import { lockMaterialization } from './materialization-metadata.ts'
import { makeNativeReplayHarness } from './materialization-recipes-test-native.ts'
import type { NativeReplayHarness } from './materialization-recipes-test-native.ts'
import {
  materializationRecipeKey,
  parseMaterializationRecipe,
  prepareMaterializationRecipe,
  publishMaterializationRecipe,
  retireMaterializationRecipe,
  validateInheritedRecipeLock,
  verifyMaterializationRecipe,
} from './materialization-recipes.ts'
import type { MaterializationRecipe } from './materialization-recipes.ts'

const recipe = parseMaterializationRecipe([
  'effect-utils/buck-materialization-recipe/v1',
  'a'.repeat(64),
  'b'.repeat(64),
  'package',
  [],
])
const key = materializationRecipeKey(recipe)
const bytes = 'recipe payload\n'.repeat(400)
const sha256 = createHash('sha256').update(bytes).digest('hex')
type RecipeFixture = {
  root: string
  contentStore: string
  metadata: string
  snapshot: string
  tree: string
  lockFd: number
  recipe: MaterializationRecipe
  key: string
  releaseRecipeLock: () => Promise<void>
}
const withFixture = async (
  run: (fixture: RecipeFixture) => Promise<void>,
  fixtureRecipe: MaterializationRecipe = recipe,
): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(editorViewTestDataRoot(), 'buck-recipes-')))
  const contentStore = join(root, 'content')
  const metadata = `${contentStore}.buck-materialization-v1`
  const recipe = fixtureRecipe
  const key = materializationRecipeKey(recipe)
  await prepareMaterializationRecipe({ contentStore, recipe })
  const lock = await lockMaterialization({ metadata, digest: key, kind: 'recipe' })
  if (lock === undefined) throw new Error('fixture lock unavailable')
  const tree = join(root, 'tree')
  mkdirSync(tree, { mode: 0o700 })
  mkdirSync(join(tree, 'directory'))
  writeFileSync(join(tree, 'directory', 'ordinary'), bytes)
  writeFileSync(join(tree, 'duplicate'), bytes)
  writeFileSync(join(tree, 'executable'), bytes, { mode: 0o755 })
  writeFileSync(join(tree, 'empty'), '')
  symlinkSync('directory/ordinary', join(tree, 'link'))
  try {
    await run({
      root,
      contentStore,
      metadata,
      snapshot: join(metadata, '.store', `recipe-${key}`),
      tree,
      lockFd: lock.fd,
      recipe,
      key,
      releaseRecipeLock: () => lock.close(),
    })
  } finally {
    await lock.close()
    const unlock = (path: string): void => {
      if (lstatSync(path).isDirectory() === false) return
      chmodSync(path, 0o700)
      for (const name of readdirSync(path)) unlock(join(path, name))
    }
    unlock(root)
    rmSync(root, { recursive: true })
  }
}
const proof = (snapshot: string): unknown[] =>
  JSON.parse(readFileSync(join(snapshot, 'verification.json'), 'utf8'))

describe('single-writer extraction recipe publication', () => {
  it('prepare creates only metadata and exclusion, and validates inherited descriptor identity', async () =>
    withFixture(async ({ root, contentStore, metadata, lockFd }) => {
      expect(readdirSync(join(metadata, '.store'))).toEqual([])
      expect(readdirSync(join(metadata, '.staging'))).toEqual([])
      expect(existsSync(contentStore)).toBe(false)
      validateInheritedRecipeLock({ contentStore, recipe, fd: lockFd })
      expect(() =>
        validateInheritedRecipeLock({ contentStore: join(root, 'other'), recipe, fd: lockFd }),
      ).toThrow()
    }))
  it('publishes native-compatible canonical manifest, distinct mode pins and ctime proof', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const text = readFileSync(join(fixture.snapshot, 'manifest.json'), 'utf8')
      const manifest = JSON.parse(text)
      expect(manifest.schema).toBe('effect-utils/buck-materialization-tree/v1')
      expect(manifest.recipe).toEqual(recipe)
      expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
        'directory',
        'directory/ordinary',
        'duplicate',
        'empty',
        'executable',
        'link',
      ])
      expect(readdirSync(join(fixture.snapshot, 'pins'))).toHaveLength(3)
      const wire = proof(fixture.snapshot)
      expect(wire[0]).toBe('effect-utils/buck-materialization-recipe-proof/v1')
      expect(wire[1]).toEqual([
        createHash('sha256').update(text).digest('hex'),
        Buffer.byteLength(text),
        ...['dev', 'ino', 'mode', 'uid', 'ctimeNs'].map((field) =>
          String(
            Reflect.get(
              lstatSync(join(fixture.snapshot, 'manifest.json'), { bigint: true }),
              field,
            ),
          ),
        ),
      ])
      expect(lstatSync(join(fixture.metadata, '.leases', `recipe-${key}.lock`)).mode & 0o777).toBe(
        0o600,
      )
      const pin = join(fixture.snapshot, 'pins', `${sha256}-0444`)
      expect(lstatSync(pin).ino).toBe(
        lstatSync(join(fixture.contentStore, sha256.slice(0, 2), `${sha256}-0444`)).ino,
      )
    }))
  it('rehashes on ctime change and refreshes exact descriptor proof without replacing content', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const before = readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')
      const pin = join(fixture.snapshot, 'pins', `${sha256}-0444`)
      const extra = join(fixture.root, 'temporary-link')
      linkSync(pin, extra)
      unlinkSync(extra)
      await verifyMaterializationRecipe({ ...fixture, recipe })
      expect(readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')).not.toBe(before)
      expect(readFileSync(pin, 'utf8')).toBe(bytes)
    }))
  it('does not adopt a modified manifest digest or overwrite corrupt payloads', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const manifest = join(fixture.snapshot, 'manifest.json')
      const established = readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')
      chmodSync(manifest, 0o644)
      writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('ordinary', 'modified'))
      chmodSync(manifest, 0o444)
      await expect(verifyMaterializationRecipe({ ...fixture, recipe })).rejects.toThrow(
        'digest mismatch',
      )
      expect(readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')).toBe(established)
    }))
  it('rejects bad blob bytes while preserving the established proof', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const pin = join(fixture.snapshot, 'pins', `${sha256}-0444`)
      const established = readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')
      chmodSync(pin, 0o644)
      writeFileSync(pin, 'X'.repeat(Buffer.byteLength(bytes)))
      chmodSync(pin, 0o444)
      await expect(verifyMaterializationRecipe({ ...fixture, recipe })).rejects.toThrow(
        'digest mismatch',
      )
      expect(readFileSync(pin, 'utf8')).toBe('X'.repeat(Buffer.byteLength(bytes)))
      expect(readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')).toBe(established)
    }))
  it('retains SH readers and recipe EX writers, then retires through the sole CAS collector', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const lease = acquireExistingEditorViewLeaseUnderFence({
        editorRoot: fixture.metadata,
        snapshot: fixture.snapshot,
      })
      // Outer EX writer independently excludes pressure even before SH admission.
      await maintainArchiveContent({ contentStore: fixture.contentStore, highWaterBytes: 1 })
      await retireMaterializationRecipe({ ...fixture, generation: `recipe-${key}` })
      expect(existsSync(fixture.snapshot)).toBe(true)
      lease.release()
      await retireMaterializationRecipe({ ...fixture, generation: `recipe-${key}` })
      expect(existsSync(fixture.snapshot)).toBe(false)
      await collectEditorViewContentStore({ contentStore: fixture.contentStore })
    }))
  it('rejects missing controls after rename and preserves garbage evidence', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const garbage = join(
        fixture.metadata,
        '.garbage',
        `recipe-${key}-11111111-1111-1111-1111-111111111111`,
      )
      renameSync(fixture.snapshot, garbage)
      unlinkSync(join(fixture.metadata, '.leases', `recipe-${key}.lock`))
      // Direct retirement retains this fixture's caller-owned EX throughout.
      await expect(
        retireMaterializationRecipe({
          contentStore: fixture.contentStore,
          metadata: fixture.metadata,
          generation: `recipe-${key}`,
          garbageName: garbage.split('/').at(-1)!,
        }),
      ).rejects.toThrow('unsafe recipe generation control')
      expect(existsSync(garbage)).toBe(true)
    }))
  it('rejects unknown store and garbage names even below pressure threshold', async () =>
    withFixture(async (fixture) => {
      mkdirSync(join(fixture.metadata, '.store', 'unknown'), { mode: 0o700 })
      await expect(
        maintainArchiveContent({ contentStore: fixture.contentStore, highWaterBytes: 2 ** 30 }),
      ).rejects.toThrow('unknown materialization generation')
      rmSync(join(fixture.metadata, '.store', 'unknown'), { recursive: true })
      mkdirSync(join(fixture.metadata, '.garbage', 'unknown'), { mode: 0o700 })
      await expect(
        maintainArchiveContent({ contentStore: fixture.contentStore, highWaterBytes: 2 ** 30 }),
      ).rejects.toThrow('unknown retired')
    }))
  it('recovers partial unpublished stages without extracting', async () =>
    withFixture(async (fixture) => {
      const stage = join(
        fixture.metadata,
        '.staging',
        `recipe-${key}-11111111-1111-1111-1111-111111111111`,
      )
      mkdirSync(stage, { mode: 0o700 })
      mkdirSync(join(stage, 'pins'), { mode: 0o700 })
      await publishMaterializationRecipe({ ...fixture, recipe })
      expect(existsSync(stage)).toBe(false)
    }))
  it('rejects escaping symlinks without publishing a generation', async () =>
    withFixture(async (fixture) => {
      unlinkSync(join(fixture.tree, 'link'))
      symlinkSync('../outside', join(fixture.tree, 'link'))
      await expect(publishMaterializationRecipe({ ...fixture, recipe })).rejects.toThrow(
        'escaping symlink',
      )
      expect(existsSync(fixture.snapshot)).toBe(false)
    }))
  it('dispatches mixed archive and recipe pressure without counting pins twice', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const receipt = await acquireSharedArchive({
        contentStore: fixture.contentStore,
        highWaterBytes: 2 ** 30,
        url: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
        digest: sha256,
        size: Buffer.byteLength(bytes),
        output: join(fixture.root, 'archive-output'),
      })
      expect(receipt.downloadedBytes).toBe(0)
      const archive = join(fixture.metadata, '.store', `archive-${sha256}`)
      expect(existsSync(archive)).toBe(true)
      const pressure = await maintainArchiveContent({
        contentStore: fixture.contentStore,
        highWaterBytes: 1,
      })
      expect(existsSync(archive)).toBe(false)
      expect(existsSync(fixture.snapshot)).toBe(true)
      expect(pressure.metadataBytes).toBeGreaterThan(0)
      expect(pressure.combinedBytes).toBe(pressure.totalBytes + pressure.metadataBytes)
    }))
  it('recovers garbage with a partially removed pin set and retains its control tombstone', async () =>
    withFixture(async (fixture) => {
      await publishMaterializationRecipe({ ...fixture, recipe })
      const name = `recipe-${key}-11111111-1111-1111-1111-111111111111`
      const garbage = join(fixture.metadata, '.garbage', name)
      renameSync(fixture.snapshot, garbage)
      unlinkSync(join(garbage, 'pins', `${sha256}-0555`))
      await retireMaterializationRecipe({
        ...fixture,
        generation: `recipe-${key}`,
        garbageName: name,
      })
      expect(existsSync(garbage)).toBe(false)
      expect(existsSync(join(fixture.metadata, '.leases', `recipe-${key}.lock`))).toBe(true)
    }))
})

const withNativeFixture = async (
  run: (fixture: RecipeFixture, native: NativeReplayHarness) => Promise<void>,
): Promise<void> => {
  const native = makeNativeReplayHarness()
  try {
    await withFixture(async (fixture) => run(fixture, native), native.recipe)
  } finally {
    native.dispose()
  }
}

const expectPrivateReplay = ({ output, snapshot }: { output: string; snapshot: string }): void => {
  expect(readFileSync(join(output, 'directory', 'ordinary'), 'utf8')).toBe(bytes)
  expect(readFileSync(join(output, 'duplicate'), 'utf8')).toBe(bytes)
  expect(readFileSync(join(output, 'executable'), 'utf8')).toBe(bytes)
  expect(readFileSync(join(output, 'empty'), 'utf8')).toBe('')
  expect(readlinkSync(join(output, 'link'))).toBe('directory/ordinary')
  expect(lstatSync(join(output, 'directory')).mode & 0o777).toBe(0o755)
  for (const [name, mode] of [
    ['duplicate', 0o644],
    ['executable', 0o755],
  ] as const) {
    const outputStatus = lstatSync(join(output, name), { bigint: true })
    const pinStatus = lstatSync(
      join(snapshot, 'pins', `${sha256}-${mode === 0o755 ? '0555' : '0444'}`),
      { bigint: true },
    )
    expect(Number(outputStatus.mode & 0o777n)).toBe(mode)
    expect(outputStatus.nlink).toBe(1n)
    expect([outputStatus.dev, outputStatus.ino]).not.toEqual([pinStatus.dev, pinStatus.ino])
  }
}

// Advance only the proof's real filesystem ctime, never manufacture source
// tuples. This makes the metadata-warm assertion independent of clock resolution.
const establishNonRacyProof = async (fixture: RecipeFixture): Promise<void> => {
  const path = join(fixture.snapshot, 'verification.json')
  const established = readFileSync(path)
  const sources = [
    join(fixture.snapshot, 'manifest.json'),
    ...readdirSync(join(fixture.snapshot, 'pins')).map((name) =>
      join(fixture.snapshot, 'pins', name),
    ),
  ]
  const deadline = Date.now() + 5000
  while (true) {
    const proofStatus = lstatSync(path, { bigint: true })
    if (
      sources.every((source) => {
        const status = lstatSync(source, { bigint: true })
        return status.dev === proofStatus.dev && status.ctimeNs < proofStatus.ctimeNs
      }) === true
    )
      return
    if (Date.now() > deadline)
      throw new Error('fixture filesystem did not establish a strictly newer proof')
    // Real filesystem ctime granularity is the condition under test; a fake
    // clock cannot advance kernel inode metadata.
    await Bun.sleep(2)
    writeFileSync(path, established)
  }
}

const expectExactRefreshedProof = (fixture: RecipeFixture): void => {
  const wire = JSON.parse(readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8'))
  for (const [path, tuple] of [
    [join(fixture.snapshot, 'manifest.json'), wire[1]],
    ...wire[2].map(([name, tuple]: [string, unknown[]]) => [
      join(fixture.snapshot, 'pins', name),
      tuple,
    ]),
  ]) {
    const status = lstatSync(path, { bigint: true })
    expect(tuple.slice(2)).toEqual(
      [status.dev, status.ino, status.mode, status.uid, status.ctimeNs].map(String),
    )
  }
}

describe(
  'attested native ↔ TypeScript recipe interop (required PR-side binaries)',
  { timeout: 30000 },
  () => {
    it('consumes a TS-published generation without extraction, publisher calls, proof writes or shared output inodes', async () =>
      withNativeFixture(async (fixture, native) => {
        await publishMaterializationRecipe(fixture)
        await establishNonRacyProof(fixture)
        const proofBefore = readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')
        const statusBefore = lstatSync(join(fixture.snapshot, 'verification.json'), {
          bigint: true,
        })
        await fixture.releaseRecipeLock()
        for (const name of ['first', 'second']) {
          // Sequential independent native consumers share only the immutable source.
          const replay = native.start({ ...fixture, name })
          const result = await replay.completed
          expect(result, result.stderr).toMatchObject({ code: 0 })
          const receipt = JSON.parse(readFileSync(replay.receipt, 'utf8'))
          expect(receipt).toMatchObject({
            schema: 'effect-utils/buck-materialization-replay-receipt/v1',
            recipeKey: fixture.key,
            cacheHit: true,
            extractionCount: 0,
            patchCount: 0,
            linkedFiles: 0,
            linkedBytes: 0,
            sourceVerification: 'metadata-proof',
          })
          expect(receipt.clonedFiles + receipt.copiedFiles).toBe(4)
          expect(receipt.clonedBytes + receipt.copiedBytes).toBe(Buffer.byteLength(bytes) * 3)
          expect(replay.bridgeOperations()).toEqual([])
          expectPrivateReplay({ ...fixture, output: replay.output })
          writeFileSync(join(replay.output, 'duplicate'), 'private consumer mutation')
          expect(readFileSync(join(fixture.snapshot, 'pins', `${sha256}-0444`), 'utf8')).toBe(bytes)
        }
        expect(readFileSync(join(fixture.snapshot, 'verification.json'), 'utf8')).toBe(proofBefore)
        const statusAfter = lstatSync(join(fixture.snapshot, 'verification.json'), { bigint: true })
        expect([statusAfter.ino, statusAfter.ctimeNs]).toEqual([
          statusBefore.ino,
          statusBefore.ctimeNs,
        ])
      }))

    it('blocks TS retirement while native holds SH, then permits retirement after private installation', async () =>
      withNativeFixture(async (fixture, native) => {
        await publishMaterializationRecipe(fixture)
        const extra = join(fixture.root, 'ctime-bump')
        linkSync(join(fixture.snapshot, 'pins', `${sha256}-0444`), extra)
        unlinkSync(extra)
        await fixture.releaseRecipeLock()
        const replay = native.start({ ...fixture, name: 'leased', hold: true })
        try {
          await replay.waitForVerification()
          const probe = probeEditorViewLease({
            editorRoot: fixture.metadata,
            snapshot: fixture.snapshot,
          })
          try {
            expect(probe.state).toBe('held')
          } finally {
            probe.release()
          }
          expect(
            await lockMaterialization({
              metadata: fixture.metadata,
              digest: fixture.key,
              kind: 'recipe',
              wait: false,
            }),
          ).toBeUndefined()
          // The cooperating native writer retains recipe EX at this barrier. Call
          // retirement directly as its delegate to isolate SH exclusion, rather
          // than mistaking failure to acquire recipe EX for a generation lease.
          await retireMaterializationRecipe({ ...fixture, generation: `recipe-${fixture.key}` })
          expect(existsSync(fixture.snapshot)).toBe(true)
          expect(readdirSync(join(fixture.snapshot, 'pins'))).toHaveLength(3)
          await maintainArchiveContent({ contentStore: fixture.contentStore, highWaterBytes: 1 })
          expect(existsSync(fixture.snapshot)).toBe(true)
          replay.release()
          const result = await replay.completed
          expect(result, result.stderr).toMatchObject({ code: 0 })
          expect(replay.bridgeOperations()).toEqual(['verify'])
          expectPrivateReplay({ ...fixture, output: replay.output })
          const lock = await lockMaterialization({
            metadata: fixture.metadata,
            digest: fixture.key,
            kind: 'recipe',
          })
          if (lock === undefined) throw new Error('post-replay recipe lock unavailable')
          try {
            await retireMaterializationRecipe({ ...fixture, generation: `recipe-${fixture.key}` })
            expect(existsSync(fixture.snapshot)).toBe(false)
            // Retirement cannot revoke the already installed private output.
            expect(readFileSync(join(replay.output, 'duplicate'), 'utf8')).toBe(bytes)
          } finally {
            await lock.close()
          }
        } finally {
          replay.release()
          replay.stop()
          await replay.completed
        }
      }))

    it.each(['native', 'TypeScript'] as const)(
      '%s rehashes a source newer than its proof and refreshes exact source tuples',
      async (client) =>
        withNativeFixture(async (fixture, native) => {
          await publishMaterializationRecipe(fixture)
          await establishNonRacyProof(fixture)
          const proofPath = join(fixture.snapshot, 'verification.json')
          const before = readFileSync(proofPath, 'utf8')
          const proofStatus = lstatSync(proofPath, { bigint: true })
          const pin = join(fixture.snapshot, 'pins', `${sha256}-0444`)
          const extra = join(fixture.root, 'ctime-bump')
          const deadline = Date.now() + 5000
          do {
            linkSync(pin, extra)
            unlinkSync(extra)
            if (lstatSync(pin, { bigint: true }).ctimeNs > proofStatus.ctimeNs) break
            if (Date.now() > deadline)
              throw new Error('fixture source ctime did not advance beyond proof')
            await Bun.sleep(2)
          } while (lstatSync(pin, { bigint: true }).ctimeNs <= proofStatus.ctimeNs)
          expect(lstatSync(pin, { bigint: true }).ctimeNs).toBeGreaterThan(proofStatus.ctimeNs)
          if (client === 'TypeScript') await verifyMaterializationRecipe(fixture)
          else {
            await fixture.releaseRecipeLock()
            const replay = native.start({ ...fixture, name: 'newer-source' })
            const result = await replay.completed
            expect(result, result.stderr).toMatchObject({ code: 0 })
            expect(JSON.parse(readFileSync(replay.receipt, 'utf8'))).toMatchObject({
              cacheHit: true,
              extractionCount: 0,
              patchCount: 0,
              sourceVerification: 'rehash',
            })
            expect(replay.bridgeOperations()).toEqual(['verify'])
            expectPrivateReplay({ ...fixture, output: replay.output })
          }
          expect(readFileSync(proofPath, 'utf8')).not.toBe(before)
          expectExactRefreshedProof(fixture)
          expect(readFileSync(pin, 'utf8')).toBe(bytes)
        }),
    )

    it.each(['native', 'TypeScript'] as const)(
      '%s repairs untrusted cross-device proof tuples only through full verification',
      async (client) =>
        withNativeFixture(async (fixture, native) => {
          await publishMaterializationRecipe(fixture)
          const path = join(fixture.snapshot, 'verification.json')
          const wire = JSON.parse(readFileSync(path, 'utf8'))
          wire[1][2] = String(BigInt(wire[1][2]) + 1n)
          for (const [, tuple] of wire[2]) tuple[2] = String(BigInt(tuple[2]) + 1n)
          writeFileSync(path, `${JSON.stringify(wire)}\n`)
          if (client === 'TypeScript') await verifyMaterializationRecipe(fixture)
          else {
            await fixture.releaseRecipeLock()
            const replay = native.start({ ...fixture, name: 'cross-device-tuples' })
            const result = await replay.completed
            expect(result, result.stderr).toMatchObject({ code: 0 })
            expect(JSON.parse(readFileSync(replay.receipt, 'utf8')).sourceVerification).toBe(
              'rehash',
            )
            expect(replay.bridgeOperations()).toEqual(['verify'])
            expectPrivateReplay({ ...fixture, output: replay.output })
          }
          expectExactRefreshedProof(fixture)
        }),
    )

    it.each([
      'noncanonical proof',
      'wrong blob digest',
      'modified manifest',
      'hardlinked proof',
      'corrupt payload',
    ] as const)(
      'both clients reject %s without replacing evidence or installing output',
      async (corruption) =>
        withNativeFixture(async (fixture, native) => {
          await publishMaterializationRecipe(fixture)
          const path = join(fixture.snapshot, 'verification.json')
          if (corruption === 'noncanonical proof')
            writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
          else if (corruption === 'hardlinked proof')
            linkSync(path, join(fixture.root, 'extra-proof-link'))
          else if (corruption === 'wrong blob digest') {
            const wire = JSON.parse(readFileSync(path, 'utf8'))
            wire[2][0][1][0] = 'c'.repeat(64)
            writeFileSync(path, `${JSON.stringify(wire)}\n`)
          } else if (corruption === 'modified manifest') {
            const manifest = join(fixture.snapshot, 'manifest.json')
            chmodSync(manifest, 0o644)
            writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('ordinary', 'modified'))
            chmodSync(manifest, 0o444)
          } else {
            const pin = join(fixture.snapshot, 'pins', `${sha256}-0444`)
            chmodSync(pin, 0o644)
            writeFileSync(pin, 'X'.repeat(Buffer.byteLength(bytes)))
            chmodSync(pin, 0o444)
          }
          const established = readFileSync(path, 'utf8')
          await expect(verifyMaterializationRecipe(fixture)).rejects.toThrow()
          expect(readFileSync(path, 'utf8')).toBe(established)
          await fixture.releaseRecipeLock()
          const replay = native.start({ ...fixture, name: 'corrupt' })
          const result = await replay.completed
          expect(result, result.stderr).not.toMatchObject({ code: 0 })
          expect(result.stderr).not.toBe('')
          expect(existsSync(replay.output)).toBe(false)
          expect(existsSync(replay.receipt)).toBe(false)
          expect(readFileSync(path, 'utf8')).toBe(established)
          expect(existsSync(fixture.snapshot)).toBe(true)
          if (corruption === 'corrupt payload')
            expect(readFileSync(join(fixture.snapshot, 'pins', `${sha256}-0444`), 'utf8')).toBe(
              'X'.repeat(Buffer.byteLength(bytes)),
            )
        }),
    )
  },
)

describe('native replay races with TS proof refresh', { timeout: 30000 }, () => {
  it('rejects payload mutation after the real TS verifier returns, without re-extracting or replacing proof evidence', async () =>
    withNativeFixture(async (fixture, native) => {
      await publishMaterializationRecipe(fixture)
      const pin = join(fixture.snapshot, 'pins', `${sha256}-0444`)
      const extra = join(fixture.root, 'ctime-bump')
      linkSync(pin, extra)
      unlinkSync(extra)
      await fixture.releaseRecipeLock()
      const replay = native.start({ ...fixture, name: 'post-verification-race', hold: true })
      try {
        await replay.waitForVerification()
        const proofPath = join(fixture.snapshot, 'verification.json')
        const established = readFileSync(proofPath, 'utf8')
        chmodSync(pin, 0o644)
        writeFileSync(pin, 'X'.repeat(Buffer.byteLength(bytes)))
        chmodSync(pin, 0o444)
        replay.release()
        const result = await replay.completed
        expect(result, result.stderr).not.toMatchObject({ code: 0 })
        expect(result.stderr).toContain('verification did not establish matching proof')
        expect(replay.bridgeOperations()).toEqual(['verify'])
        expect(existsSync(replay.output)).toBe(false)
        expect(existsSync(replay.receipt)).toBe(false)
        expect(readFileSync(proofPath, 'utf8')).toBe(established)
        const lock = await lockMaterialization({
          metadata: fixture.metadata,
          digest: fixture.key,
          kind: 'recipe',
        })
        if (lock === undefined) throw new Error('post-race recipe lock unavailable')
        try {
          await expect(
            verifyMaterializationRecipe({ ...fixture, lockFd: lock.fd }),
          ).rejects.toThrow('digest mismatch')
          expect(readFileSync(proofPath, 'utf8')).toBe(established)
          expect(readFileSync(pin, 'utf8')).toBe('X'.repeat(Buffer.byteLength(bytes)))
        } finally {
          await lock.close()
        }
      } finally {
        replay.release()
        replay.stop()
        await replay.completed
      }
    }))
})
