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
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { acquireEditorViewLease } from './editor-view-leases.ts'
import {
  collectEditorViewContentStore,
  editorViewContentStoreCensus,
  immutableContentProofIsNonRacy,
  shareSnapshotFiles,
  withEditorViewContentStoreLock,
} from './editor-view-sharing.ts'
import { editorViewTestDataRoot } from './editor-view-test-filesystem.ts'
import {
  acquireSharedArchive,
  archiveSharingAdmission,
  maintainArchiveContent,
} from './materialization-archives.ts'

const bytes = Buffer.from('archive fixture payload\n'.repeat(400))
const digest = createHash('sha256').update(bytes).digest('hex')
const url = 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'
const highWaterBytes = 4 * 1024 ** 3
const removeFixture = (root: string): void => {
  const unlock = (path: string): void => {
    if (lstatSync(path).isDirectory() === false) return
    // Only this fixture's private directories; never change linked file modes.
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) unlock(join(path, name))
  }
  unlock(root)
  rmSync(root, { recursive: true })
}
const withFixture = async (
  run: (root: string, contentStore: string) => Promise<void>,
): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(editorViewTestDataRoot(), 'buck-archives-')))
  try {
    await run(root, join(root, 'content'))
  } finally {
    removeFixture(root)
  }
}

// Real loopback transport, not a fake HTTP response. The production service still
// validates the declared public origin and every redirect before transport.
const withRegistry = async (
  run: (
    transport: (url: string, options: RequestInit) => Promise<Response>,
    requests: () => number,
  ) => Promise<void>,
): Promise<void> => {
  let count = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      count++
      return new Response(bytes)
    },
  })
  try {
    await run(
      (_url, options) => fetch(server.url, options),
      () => count,
    )
  } finally {
    server.stop(true)
  }
}

describe('host-local registry archives', () => {
  it('trusts only strictly older source timestamps on the proof filesystem', () => {
    const source = { dev: 1n, ctimeNs: 20n }
    expect(immutableContentProofIsNonRacy({ source, proof: { dev: 1n, ctimeNs: 21n } })).toBe(true)
    expect(immutableContentProofIsNonRacy({ source, proof: { dev: 1n, ctimeNs: 20n } })).toBe(false)
    expect(immutableContentProofIsNonRacy({ source, proof: { dev: 1n, ctimeNs: 19n } })).toBe(false)
    expect(immutableContentProofIsNonRacy({ source, proof: { dev: 2n, ctimeNs: 21n } })).toBe(false)
  })

  it('downloads once across concurrent roots and keeps Buck outputs independent of CAS', async () => {
    await withFixture(async (root, contentStore) =>
      withRegistry(async (fetchResponse, requests) => {
        const acquire = (name: string) =>
          acquireSharedArchive({
            contentStore,
            highWaterBytes,
            url,
            digest,
            size: bytes.length,
            output: join(root, name),
            fetchResponse,
          })
        const receipts = await Promise.all([acquire('w1'), acquire('w2'), acquire('w3')])
        expect(requests()).toBe(1)
        expect(receipts.reduce((sum, receipt) => sum + receipt.downloadedBytes, 0)).toBe(
          bytes.length,
        )
        expect(receipts.filter((receipt) => receipt.cacheHit)).toHaveLength(2)
        const blob = join(contentStore, digest.slice(0, 2), `${digest}-0444`)
        for (const name of ['w1', 'w2', 'w3']) {
          expect(readFileSync(join(root, name))).toEqual(bytes)
          expect(lstatSync(join(root, name)).ino).not.toBe(lstatSync(blob).ino)
        }
        // Simulate real Buck's ordinary-file finalization on its independent output.
        chmodSync(join(root, 'w1'), 0o644)
        writeFileSync(join(root, 'w1'), 'private output changed')
        expect(lstatSync(blob).mode & 0o777).toBe(0o444)
        expect(readFileSync(blob)).toEqual(bytes)
        await collectEditorViewContentStore({ contentStore })
        expect(existsSync(blob)).toBe(true)
      }),
    )
  })

  it('reuses a generic CAS blob without network or a package index', async () => {
    await withFixture(async (root, contentStore) => {
      const seed = join(root, 'editor')
      mkdirSync(seed)
      writeFileSync(join(seed, 'payload'), bytes)
      await shareSnapshotFiles({ candidate: seed, contentStore })
      const receipt = await acquireSharedArchive({
        contentStore,
        highWaterBytes,
        url,
        digest,
        size: bytes.length,
        output: join(root, 'output'),
        fetchResponse: async () => {
          throw new Error('unexpected network')
        },
      })
      expect(receipt.downloadedBytes).toBe(0)
      expect(readFileSync(join(root, 'output'))).toEqual(bytes)
    })
  })

  it('completes an archive hit while an unrelated CAS metadata fence is held', async () => {
    await withFixture(async (root, contentStore) =>
      withRegistry(async (fetchResponse) => {
        const acquire = (name: string) =>
          acquireSharedArchive({
            contentStore,
            highWaterBytes,
            url,
            digest,
            size: bytes.length,
            output: join(root, name),
            fetchResponse,
          })
        await acquire('seed')
        await withEditorViewContentStoreLock({
          contentStore,
          run: async () => {
            const hit = await acquire('hit')
            expect(hit.downloadedBytes).toBe(0)
            expect(readFileSync(join(root, 'hit'))).toEqual(bytes)
          },
        })
      }),
    )
  })

  it('rate-bounds insertion maintenance and never opens its control on an archive hit', async () => {
    await withFixture(async (root, contentStore) =>
      withRegistry(async (fetchResponse) => {
        await acquireSharedArchive({
          contentStore,
          highWaterBytes,
          url,
          digest,
          size: bytes.length,
          output: join(root, 'first'),
          fetchResponse,
        })
        const control = join(
          `${contentStore}.buck-materialization-v1`,
          '.downloads',
          'maintenance.lock',
        )
        const recent = new Date(Date.now() - 1000)
        utimesSync(control, recent, recent)
        const previous = lstatSync(control).mtimeMs
        const other = Buffer.from('another already verified editor payload')
        const seed = join(root, 'editor')
        mkdirSync(seed)
        writeFileSync(join(seed, 'payload'), other)
        await shareSnapshotFiles({ candidate: seed, contentStore })
        await acquireSharedArchive({
          contentStore,
          highWaterBytes,
          url,
          digest: createHash('sha256').update(other).digest('hex'),
          size: other.length,
          output: join(root, 'second'),
          fetchResponse,
        })
        expect(lstatSync(control).mtimeMs).toBe(previous)
        // The hit must not even validate/open the unrelated maintenance control.
        chmodSync(control, 0o644)
        // Nor may a hit enumerate recovery staging, even for its own digest.
        writeFileSync(
          join(`${contentStore}.buck-materialization-v1`, '.staging', `${digest}-invalid-stage`),
          'unrelated recovery evidence',
        )
        const hit = await acquireSharedArchive({
          contentStore,
          highWaterBytes,
          url,
          digest,
          size: bytes.length,
          output: join(root, 'hit'),
          fetchResponse,
        })
        expect(hit.downloadedBytes).toBe(0)
        expect(readFileSync(join(root, 'hit'))).toEqual(bytes)
      }),
    )
  })

  it.each(['write-with-restored-mtime', 'chmod-roundtrip', 'new-pin'] as const)(
    'revalidates the publication ctime proof after %s',
    async (change) => {
      await withFixture(async (root, contentStore) =>
        withRegistry(async (fetchResponse, requests) => {
          const acquire = (name: string) =>
            acquireSharedArchive({
              contentStore,
              highWaterBytes,
              url,
              digest,
              size: bytes.length,
              output: join(root, name),
              fetchResponse,
            })
          expect((await acquire('seed')).sourceVerification).toBe('publication')
          const blob = join(contentStore, digest.slice(0, 2), `${digest}-0444`)
          const fixedTime = new Date('2020-01-01T00:00:00.000Z')
          utimesSync(blob, fixedTime, fixedTime)
          expect((await acquire('normalized-time')).sourceVerification).toBe('rehash')
          const proof = join(
            `${contentStore}.buck-materialization-v1`,
            '.store',
            `archive-${digest}`,
            'verification.json',
          )
          const expectWarm = async (name: string): Promise<void> => {
            const nonRacy = immutableContentProofIsNonRacy({
              source: lstatSync(blob, { bigint: true }),
              proof: lstatSync(proof, { bigint: true }),
            })
            expect((await acquire(name)).sourceVerification).toBe(
              nonRacy === true ? 'metadata-proof' : 'rehash',
            )
          }
          await expectWarm('warm')
          const before = lstatSync(blob, { bigint: true })
          const previousProof = readFileSync(proof, 'utf8')
          const previousProofStatus = lstatSync(proof, { bigint: true })
          if (change === 'new-pin') linkSync(blob, join(root, 'another-pin'))
          else {
            chmodSync(blob, 0o644)
            if (change === 'write-with-restored-mtime') {
              writeFileSync(blob, Buffer.alloc(bytes.length))
              utimesSync(blob, fixedTime, fixedTime)
            }
            chmodSync(blob, 0o444)
          }
          expect(lstatSync(blob, { bigint: true }).mtimeNs).toBe(before.mtimeNs)
          const after = lstatSync(blob, { bigint: true })
          expect(
            after.ctimeNs !== before.ctimeNs ||
              immutableContentProofIsNonRacy({ source: after, proof: previousProofStatus }) ===
                false,
          ).toBe(true)
          if (change === 'write-with-restored-mtime') {
            await expect(acquire('changed')).rejects.toThrow('content or identity mismatch')
            expect(existsSync(join(root, 'changed'))).toBe(false)
            expect(readFileSync(proof, 'utf8')).toBe(previousProof)
          } else {
            expect((await acquire('changed')).sourceVerification).toBe('rehash')
            expect(lstatSync(proof, { bigint: true }).ino).not.toBe(previousProofStatus.ino)
            await expectWarm('refreshed')
            expect(readFileSync(join(root, 'refreshed'))).toEqual(bytes)
          }
          expect(requests()).toBe(1)
        }),
      )
    },
  )

  it.each(['digest', 'size', 'writable', 'symlink'] as const)(
    'rejects %s corruption instead of silently fetching',
    async (kind) => {
      await withFixture(async (root, contentStore) =>
        withRegistry(async (fetchResponse, requests) => {
          const options = {
            contentStore,
            highWaterBytes,
            url,
            digest,
            size: bytes.length,
            output: join(root, 'w1'),
            fetchResponse,
          }
          await acquireSharedArchive(options)
          const blob = join(contentStore, digest.slice(0, 2), `${digest}-0444`)
          if (kind === 'writable' || kind === 'digest') {
            chmodSync(blob, 0o644)
            if (kind === 'digest') {
              writeFileSync(blob, Buffer.alloc(bytes.length))
              chmodSync(blob, 0o444)
            }
          }
          if (kind === 'symlink') {
            const pin = join(
              `${contentStore}.buck-materialization-v1`,
              '.store',
              `archive-${digest}`,
              'pins',
              `${digest}-0444`,
            )
            unlinkSync(pin)
            symlinkSync(blob, pin)
          }
          await expect(
            acquireSharedArchive({
              ...options,
              output: join(root, 'w2'),
              size: kind === 'size' ? bytes.length + 1 : bytes.length,
            }),
          ).rejects.toThrow()
          expect(requests()).toBe(1)
          expect(existsSync(join(root, 'w2'))).toBe(false)
        }),
      )
    },
  )

  it('rejects bad downloads and redirect escape without publishing partial bytes', async () => {
    await withFixture(async (root, contentStore) =>
      withRegistry(async (fetchResponse) => {
        const options = {
          contentStore,
          highWaterBytes,
          url,
          digest: '0'.repeat(64),
          size: bytes.length,
          output: join(root, 'w1'),
          fetchResponse,
        }
        await expect(acquireSharedArchive(options)).rejects.toThrow('digest/size')
        expect(existsSync(join(contentStore, '00', `${options.digest}-0444`))).toBe(false)
        await expect(
          acquireSharedArchive({
            ...options,
            digest,
            fetchResponse: async () =>
              new Response(null, {
                status: 302,
                headers: { location: 'http://unapproved.invalid/payload' },
              }),
          }),
        ).rejects.toThrow('approved public HTTPS')
        expect(readdirSync(join(`${contentStore}.buck-materialization-v1`, '.store'))).toHaveLength(
          0,
        )
      }),
    )
  })

  it('preserves a published generation and releases digest exclusion when its control is corrupt', async () => {
    await withFixture(async (root, contentStore) =>
      withRegistry(async (fetchResponse, requests) => {
        const metadata = `${contentStore}.buck-materialization-v1`
        mkdirSync(join(metadata, '.leases'), { recursive: true, mode: 0o700 })
        writeFileSync(join(metadata, '.leases', `archive-${digest}.lock`), 'bad', { mode: 0o600 })
        const options = {
          contentStore,
          highWaterBytes,
          url,
          digest,
          size: bytes.length,
          output: join(root, 'output'),
          fetchResponse,
        }
        await expect(acquireSharedArchive(options)).rejects.toThrow('control identity')
        await expect(acquireSharedArchive(options)).rejects.toThrow('control identity')
        expect(requests()).toBe(1)
        expect(
          readFileSync(join(metadata, '.store', `archive-${digest}`, 'pins', `${digest}-0444`)),
        ).toEqual(bytes)
      }),
    )
  })

  it('retains leased archives over cap, then retires unleased pins with persistent controls', async () => {
    await withFixture(async (root, contentStore) =>
      withRegistry(async (fetchResponse) => {
        await acquireSharedArchive({
          contentStore,
          highWaterBytes,
          url,
          digest,
          size: bytes.length,
          output: join(root, 'w1'),
          fetchResponse,
        })
        const metadata = `${contentStore}.buck-materialization-v1`
        const snapshot = join(metadata, '.store', `archive-${digest}`)
        const lease = await acquireEditorViewLease({
          editorRoot: metadata,
          contentStore,
          resolveSnapshot: () => snapshot,
        })
        try {
          const receipt = await maintainArchiveContent({ contentStore, highWaterBytes: 1 })
          expect(receipt.state).toBe('referenced-bytes-over-cap')
          expect(receipt.referencedBytes).toBeGreaterThan(1)
          expect(existsSync(snapshot)).toBe(true)
        } finally {
          lease.release()
        }
        const receipt = await maintainArchiveContent({ contentStore, highWaterBytes: 1 })
        expect(receipt.totalBytes).toBe(0)
        expect(existsSync(snapshot)).toBe(false)
        expect(existsSync(join(metadata, '.leases', `archive-${digest}.lock`))).toBe(true)
        expect(readFileSync(join(root, 'w1'))).toEqual(bytes)
      }),
    )
  })

  it('collects unreferenced CAS bytes in successful-use LRU order and stops at high water', async () => {
    await withFixture(async (root, contentStore) => {
      const candidate = join(root, 'candidate')
      mkdirSync(candidate)
      const older = Buffer.alloc(8192, 'a')
      const newer = Buffer.alloc(8192, 'b')
      writeFileSync(join(candidate, 'older'), older)
      writeFileSync(join(candidate, 'newer'), newer)
      await shareSnapshotFiles({ candidate, contentStore })
      const oldDigest = createHash('sha256').update(older).digest('hex')
      const newDigest = createHash('sha256').update(newer).digest('hex')
      const hints = join(root, 'hints')
      mkdirSync(hints)
      writeFileSync(join(hints, `${oldDigest}-0444`), '')
      writeFileSync(join(hints, `${newDigest}-0444`), '')
      utimesSync(join(hints, `${oldDigest}-0444`), 1, 1)
      utimesSync(join(hints, `${newDigest}-0444`), 2, 2)
      unlinkSync(join(candidate, 'older'))
      unlinkSync(join(candidate, 'newer'))
      const census = await editorViewContentStoreCensus(contentStore)
      await collectEditorViewContentStore({
        contentStore,
        pressure: { highWaterBytes: census.totalBytes / 2, accessDirectory: hints },
      })
      expect(existsSync(join(contentStore, oldDigest.slice(0, 2), `${oldDigest}-0444`))).toBe(false)
      expect(existsSync(join(contentStore, newDigest.slice(0, 2), `${newDigest}-0444`))).toBe(true)
    })
  })

  it('releases download exclusion after SIGKILL and discards only its unpublished partial staging', async () => {
    await withFixture(async (root, contentStore) => {
      let requested!: () => void
      const request = new Promise<void>((resolve) => {
        requested = resolve
      })
      let partial = true
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => {
          requested()
          return partial === true
            ? new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes.subarray(0, 1))
                  },
                }),
              )
            : new Response(bytes)
        },
      })
      const program = `import { acquireSharedArchive } from ${JSON.stringify(new URL('./materialization-archives.ts', import.meta.url).href)}; await acquireSharedArchive(${JSON.stringify({ contentStore, highWaterBytes, url, digest, size: bytes.length, output: join(root, 'crashed') }).slice(0, -1)}, fetchResponse: (_url, options) => fetch(${JSON.stringify(server.url.href)}, options) });`
      const child = Bun.spawn(
        [process.env['BUN_BIN'] ?? process.execPath, '--no-env-file', '--eval', program],
        { env: process.env, stdout: 'ignore', stderr: 'pipe' },
      )
      try {
        await Promise.race([
          request,
          child.exited.then(async () => {
            throw new Error(await new Response(child.stderr).text())
          }),
        ])
        child.kill('SIGKILL')
        await child.exited
        partial = false
        const receipt = await acquireSharedArchive({
          contentStore,
          highWaterBytes,
          url,
          digest,
          size: bytes.length,
          output: join(root, 'recovered'),
          fetchResponse: (_url, options) => fetch(server.url, options),
        })
        expect(receipt.downloadedBytes).toBe(bytes.length)
        expect(readFileSync(join(root, 'recovered'))).toEqual(bytes)
        expect(
          readdirSync(join(`${contentStore}.buck-materialization-v1`, '.staging')),
        ).toHaveLength(0)
      } finally {
        child.kill()
        await child.exited
        server.stop(true)
      }
    })
  })

  it('admits registered sibling roots on the megarepo filesystem and rejects root-local overrides', async () => {
    await withFixture(async (root) => {
      const repository = join(root, '.megarepo', 'repository')
      const common = join(repository, '.bare')
      const worktree = join(repository, 'refs', 'heads', 'feature')
      const administration = join(common, 'worktrees', 'feature')
      mkdirSync(administration, { recursive: true })
      mkdirSync(worktree, { recursive: true })
      writeFileSync(join(worktree, '.git'), `gitdir: ${administration}\n`)
      writeFileSync(join(administration, 'commondir'), '../..\n')
      writeFileSync(join(administration, 'gitdir'), `${join(worktree, '.git')}\n`)
      const env = { EDITOR_VIEW_LEASE_LIBRARY: process.env['EDITOR_VIEW_LEASE_LIBRARY'] }
      expect(archiveSharingAdmission({ repoRoot: worktree, env })).toEqual({
        contentStore: join(repository, '.editor-view-content', 'v1'),
        highWaterBytes,
      })
      expect(
        archiveSharingAdmission({
          repoRoot: worktree,
          env: { ...env, EDITOR_VIEW_CONTENT_STORE: join(worktree, 'job-local') },
        }),
      ).toBeUndefined()
      expect(() =>
        archiveSharingAdmission({
          repoRoot: worktree,
          env: { ...env, EDITOR_VIEW_CONTENT_STORE_HIGH_WATER_BYTES: '0' },
        }),
      ).toThrow('positive decimal')
      writeFileSync(join(administration, 'gitdir'), `${join(root, 'different-root', '.git')}\n`)
      expect(() => archiveSharingAdmission({ repoRoot: worktree, env })).toThrow()
    })
  })

  it('selects native acquisition for disabled, CI and unregistered job-local roots without creating cache state', async () => {
    await withFixture(async (root, contentStore) => {
      for (const env of [
        { BUCK2_HOST_MATERIALIZATION: '0' },
        { CI: 'true' },
        { EDITOR_VIEW_LEASE_LIBRARY: process.env['EDITOR_VIEW_LEASE_LIBRARY'] },
      ])
        expect(archiveSharingAdmission({ repoRoot: root, env })).toBeUndefined()
      expect(existsSync(contentStore)).toBe(false)
    })
  })
})
