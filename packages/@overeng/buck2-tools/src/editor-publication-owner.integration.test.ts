import { dlopen, ptr } from 'bun:ffi'
import { expect, it } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { runCommand } from './buck-watch.ts'
import {
  editorPublicationLockPath,
  releaseEditorPublicationOwner,
  requireEditorPublicationOwner,
  tryAcquireEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const ownerLibrary = process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY
if (ownerLibrary === undefined || ownerLibrary.length === 0)
  throw new Error('Owner regression requires BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY')
const supervisor = process.env.BUCK2_EDITOR_PUBLICATION_SUPERVISOR
if (supervisor === undefined || supervisor.startsWith('/') === false)
  throw new Error('Owner regression requires absolute BUCK2_EDITOR_PUBLICATION_SUPERVISOR')
const bash = process.env.BASH_BIN
if (bash === undefined || bash.startsWith('/') === false)
  throw new Error('Owner regression requires absolute BASH_BIN')
const native = dlopen(ownerLibrary, {
  buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' },
  clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' },
})
// Retain both the timespec storage and pointer, using the owner's boot-relative clock.
const time = Buffer.alloc(16)
const timePointer = ptr(time)
const monotonicSeconds = (): number => {
  expect(native.symbols.clock_gettime(process.platform === 'darwin' ? 8 : 1, timePointer)).toBe(0)
  return Number(time.readBigInt64LE(0)) + Number(time.readBigInt64LE(8)) / 1e9
}
const moduleUrl = new URL('./editor-publication-owner.ts', import.meta.url).href
const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-publication-descendant-')))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const canAcquire = (root: string): boolean => {
  const fd = openSync(editorPublicationLockPath(root), 'r+')
  try {
    return native.symbols.buck2_publication_owner_lock(fd, 2 | 4) === 0
  } finally {
    closeSync(fd)
  }
}
// The child inspects real open descriptors rather than relying on an absent environment variable.
const childAssertions = (root: string): string => `
  import { strict as assert } from 'node:assert';
  import { fstatSync, readdirSync, statSync } from 'node:fs';
  import {
    editorPublicationLockPath, requireEditorPublicationOwner, tryAcquireEditorPublicationOwner
  } from ${JSON.stringify(moduleUrl)};
  const root = ${JSON.stringify(root)};
  const expected = statSync(editorPublicationLockPath(root));
  for (const entry of readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
    let actual;
    try { actual = fstatSync(Number(entry)); }
    catch (error) { if (error.code === 'EBADF') continue; throw error; }
    assert.ok(actual.dev !== expected.dev || actual.ino !== expected.ino,
      'child inherited the publication owner inode');
  }
  assert.throws(() => requireEditorPublicationOwner({ root }), /live in-process publication owner/);
  for (const owner of [{}, { fd: 3 }, { fd: Number(process.env.BUCK2_EDITOR_PUBLICATION_OWNER_FD) }]) {
    assert.throws(() => requireEditorPublicationOwner({ root, owner }), /live in-process publication owner/);
  }
  assert.equal(tryAcquireEditorPublicationOwner({ root }), undefined);
`

it('does not lend the owner to a child or accept stale descriptor environment authority', () =>
  withRoot(async (root) => {
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        const child = spawnSync(
          process.execPath,
          [
            '--eval',
            `${childAssertions(root)}
              const copied = JSON.parse(${JSON.stringify(JSON.stringify(owner))});
              assert.throws(() => requireEditorPublicationOwner({ root, owner: copied }),
                /live in-process publication owner/);
              throw new Error('descendant publication failed');
            `,
          ],
          {
            // A stale environment claim cannot create authority or make withOwner borrow it.
            env: { ...process.env, BUCK2_EDITOR_PUBLICATION_OWNER_FD: '3' },
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            timeout: 10000,
          },
        )
        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        expect(child.status).toBe(1)
        expect(child.stderr).toContain('descendant publication failed')
        expect(child.stderr).not.toContain('AssertionError')
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        expect(canAcquire(root)).toBe(false)
      },
    })
    expect(canAcquire(root)).toBe(true)
  }))

it('holds exclusive ownership until the callback interrupts and joins its non-owning descendant', () =>
  withRoot(async (root) => {
    let child: ChildProcess | undefined
    let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
    try {
      await expect(
        withEditorPublicationOwner({
          root,
          run: async (owner) => {
            child = spawn(
              process.execPath,
              [
                '--eval',
                `${childAssertions(root)}
                  process.stdin.resume();
                  process.stdout.write('non-owning-descendant-ready');
                `,
              ],
              {
                env: { ...process.env, BUCK2_EDITOR_PUBLICATION_OWNER_FD: '3' },
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 10000,
              },
            )
            const closed = Promise.withResolvers<{
              code: number | null
              signal: NodeJS.Signals | null
            }>()
            exited = closed.promise
            child.once('error', closed.reject)
            child.once('close', (code, signal) => closed.resolve({ code, signal }))
            const ready = Promise.withResolvers<void>()
            let output = ''
            let stderr = ''
            child.stderr!.on('data', (data: Buffer) => {
              stderr += data.toString()
            })
            child.stdout!.on('data', (data: Buffer) => {
              output += data.toString()
              if (output.includes('non-owning-descendant-ready') === true) ready.resolve()
            })
            child.once('error', ready.reject)
            child.once('close', () =>
              ready.reject(
                new Error(`descendant exited before no-lending acknowledgement: ${stderr}`),
              ),
            )
            await ready.promise
            expect(canAcquire(root)).toBe(false)
            expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
            expect(child.kill('SIGTERM')).toBe(true)
            const result = await exited
            expect(result).toEqual({ code: null, signal: 'SIGTERM' })
            expect(stderr).toBe('')
            // Reaping the child cannot release the parent's lease. The callback still owns it.
            expect(canAcquire(root)).toBe(false)
            expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
            throw new Error('parent callback failed after joining descendant')
          },
        }),
      ).rejects.toThrow('parent callback failed after joining descendant')
      expect(canAcquire(root)).toBe(true)
      // A new process can really acquire after callback cleanup, even with a stale FD claim.
      const successor = spawnSync(
        process.execPath,
        [
          '--eval',
          `
            import { strict as assert } from 'node:assert';
            import { withEditorPublicationOwner, requireEditorPublicationOwner } from ${JSON.stringify(moduleUrl)};
            const root = ${JSON.stringify(root)};
            await withEditorPublicationOwner({ root, run: async owner => {
              assert.equal(requireEditorPublicationOwner({ root, owner }), owner);
            } });
          `,
        ],
        {
          env: { ...process.env, BUCK2_EDITOR_PUBLICATION_OWNER_FD: '3' },
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          timeout: 10000,
        },
      )
      expect({
        status: successor.status,
        signal: successor.signal,
        stderr: successor.stderr,
        error: successor.error,
      }).toEqual({
        status: 0,
        signal: null,
        stderr: '',
        error: undefined,
      })
    } finally {
      child?.kill('SIGKILL')
      await exited
    }
  }))

it('records advisory metadata from both real acquirers usable by the genuine admission diagnostic', () =>
  withRoot(async (root) => {
    const before = monotonicSeconds()
    expect(Number.isFinite(before)).toBe(true)
    const inspect = (): void => {
      const path = editorPublicationLockPath(root)
      expect(readFileSync(path).byteLength).toBeLessThanOrEqual(1024)
      const metadata = JSON.parse(readFileSync(path, 'utf8'))
      expect(metadata.started).toBeGreaterThanOrEqual(before)
      expect(metadata.started).toBeLessThanOrEqual(monotonicSeconds())
      const dump = spawnSync(supervisor, ['--admission-dump', path], {
        env: { ...process.env, BUCK2_NATIVE_BIN: '', DEVENV_ROOT: root },
        encoding: 'utf8',
        timeout: 10000,
      })
      expect({ status: dump.status, signal: dump.signal, error: dump.error }).toEqual({
        status: 0,
        signal: null,
        error: undefined,
      })
      const command = basename(process.execPath)
        .slice(0, 80)
        .replace(/[^A-Za-z0-9_.-]/g, '_')
      expect(dump.stderr).toContain(`holder recorded-pid=${process.pid} command=${command} `)
      expect(dump.stderr).toContain('held-seconds=')
      expect(dump.stderr).toContain('identity=advisory')
      expect(dump.stderr).not.toContain('holder=unparseable')
      expect(dump.stderr).not.toContain('holder=unknown')
    }
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        inspect()
        const original = readFileSync(editorPublicationLockPath(root), 'utf8')
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        expect(tryAcquireEditorPublicationOwner({ root })).toBeUndefined()
        expect(readFileSync(editorPublicationLockPath(root), 'utf8')).toBe(original)
        // Neither valid-looking content nor damaged advisory bytes confer or revoke authority.
        expect(() => requireEditorPublicationOwner({ root, owner: JSON.parse(original) })).toThrow(
          'live in-process publication owner',
        )
        writeFileSync(editorPublicationLockPath(root), 'unparseable advisory bytes')
        expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
        expect(canAcquire(root)).toBe(false)
      },
    })
    const owner = tryAcquireEditorPublicationOwner({ root })
    expect(owner).toBeDefined()
    try {
      inspect()
      expect(canAcquire(root)).toBe(false)
    } finally {
      releaseEditorPublicationOwner(owner!)
    }
    // Stale, parseable metadata is not ownership once the real flock has gone.
    expect(() =>
      requireEditorPublicationOwner({
        root,
        owner: JSON.parse(readFileSync(editorPublicationLockPath(root), 'utf8')),
      }),
    ).toThrow('live in-process publication owner')
    expect(canAcquire(root)).toBe(true)
  }))

it('closes and unlocks both acquisition paths when real metadata writes fail', () =>
  withRoot(async (root) => {
    const child = spawnSync(
      bash,
      [
        '-c',
        'set -euo pipefail; ulimit -f 0; trap "" XFSZ; exec "$@"',
        'editor-publication-write-failure',
        process.execPath,
        '--eval',
        `
      import { strict as assert } from 'node:assert';
      import { dlopen } from 'bun:ffi';
      import { closeSync, fstatSync, openSync, readdirSync, statSync } from 'node:fs';
      import {
        editorPublicationLockPath, tryAcquireEditorPublicationOwner, withEditorPublicationOwner
      } from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(root)};
      let entered = false;
      assert.throws(() => tryAcquireEditorPublicationOwner({ root }), { code: 'EFBIG' });
      await assert.rejects(withEditorPublicationOwner({
        root, run: async () => { entered = true; }
      }), { code: 'EFBIG' });
      assert.equal(entered, false);
      const path = editorPublicationLockPath(root);
      const expected = statSync(path);
      for (const entry of readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
        let actual;
        try { actual = fstatSync(Number(entry)); }
        catch (error) { if (error.code === 'EBADF') continue; throw error; }
        assert.ok(actual.dev !== expected.dev || actual.ino !== expected.ino,
          'failed metadata write leaked the owner descriptor');
      }
      const native = dlopen(process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY, {
        buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' }
      });
      const fd = openSync(path, 'r+');
      try { assert.equal(native.symbols.buck2_publication_owner_lock(fd, 2 | 4), 0); }
      finally { closeSync(fd); native.close(); }
    `,
      ],
      {
        env: process.env,
        encoding: 'utf8',
        timeout: 15000,
      },
    )
    expect({
      status: child.status,
      signal: child.signal,
      error: child.error,
      stderr: child.stderr,
    }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' })
    expect(canAcquire(root)).toBe(true)
  }))

it(
  'retains ownership until an aborted ordinary publisher child finishes cleanup and closes',
  () =>
    withRoot(async (root) => {
      const release = join(root, 'release-cleanup')
      const closed = join(root, 'cleanup-joined')
      const ready = Promise.withResolvers<void>()
      const cleaning = Promise.withResolvers<void>()
      const controller = new AbortController()
      const reason = new Error('cancel real ordinary child')
      let diagnostics = ''
      let finished = false
      const outcome = withEditorPublicationOwner({
        root,
        run: (owner) => {
          expect(requireEditorPublicationOwner({ root, owner })).toBe(owner)
          return runCommand({
            command: process.execPath,
            args: [
              '--eval',
              `${childAssertions(root)}
              import { existsSync, writeFileSync } from 'node:fs';
              const timer = setTimeout(() => process.exit(97), 5000);
              const live = setInterval(() => {}, 1000);
              process.once('SIGTERM', async () => {
                process.stderr.write('cleanup-start\\n');
                while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
                writeFileSync(${JSON.stringify(closed)}, 'joined');
                clearInterval(live);
                clearTimeout(timer);
                process.exit(0);
              });
              process.stderr.write('ordinary-child-ready\\n');
            `,
            ],
            cwd: root,
            signal: controller.signal,
            onStderr: (chunk) => {
              diagnostics += chunk
              if (diagnostics.includes('ordinary-child-ready\n') === true) ready.resolve()
              if (diagnostics.includes('cleanup-start\n') === true) cleaning.resolve()
            },
          })
        },
      }).then(
        () => {
          finished = true
          return undefined
        },
        (error: unknown) => {
          finished = true
          return error
        },
      )
      const prematureClose = outcome.then((error) => {
        throw new Error(`ordinary child closed before cleanup acknowledgement: ${diagnostics}`, {
          cause: error,
        })
      })
      try {
        await Promise.race([ready.promise, prematureClose])
        controller.abort(reason)
        await Promise.race([cleaning.promise, prematureClose])
        expect(finished).toBe(false)
        expect(canAcquire(root)).toBe(false)
        writeFileSync(release, 'release')
        expect(await outcome).toMatchObject({ name: 'AbortError', cause: reason })
        expect(readFileSync(closed, 'utf8')).toBe('joined')
        expect(canAcquire(root)).toBe(true)
      } finally {
        writeFileSync(release, 'release')
        controller.abort(reason)
        await outcome
        // A regressed early rejection must not strand its real child during test cleanup.
        const expires = performance.now() + 5_500
        while (existsSync(closed) === false && performance.now() < expires) await Bun.sleep(5)
      }
    }),
  10000,
)
