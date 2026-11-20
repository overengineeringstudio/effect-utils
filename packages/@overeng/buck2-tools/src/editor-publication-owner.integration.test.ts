import { dlopen } from 'bun:ffi'
import { expect, it } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  editorPublicationLockPath,
  requireEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const ownerLibrary = process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY
if (ownerLibrary === undefined || ownerLibrary.length === 0)
  throw new Error('Owner regression requires BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY')
const native = dlopen(ownerLibrary, {
  buck2_publication_owner_lock: { args: ['i32', 'i32'], returns: 'i32' },
})
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
            child.stderr!.on('data', (data: Buffer) => { stderr += data.toString() })
            child.stdout!.on('data', (data: Buffer) => {
              output += data.toString()
              if (output.includes('non-owning-descendant-ready')) ready.resolve()
            })
            child.once('error', ready.reject)
            child.once('close', () =>
              ready.reject(new Error(`descendant exited before no-lending acknowledgement: ${stderr}`)),
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
      expect({ status: successor.status, signal: successor.signal, stderr: successor.stderr, error: successor.error }).toEqual({
        status: 0, signal: null, stderr: '', error: undefined,
      })
    } finally {
      child?.kill('SIGKILL')
      await exited
    }
  }))
