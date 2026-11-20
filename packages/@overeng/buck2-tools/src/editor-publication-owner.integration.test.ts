import { dlopen } from 'bun:ffi'
import { expect, it } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  editorPublicationLockPath,
  editorPublicationOwnerFdEnv,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const native = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
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
    return native.symbols.flock(fd, 2 | 4) === 0
  } finally {
    closeSync(fd)
  }
}

it('accepts an inherited FD3 and never unlocks a borrowed owner, including callback failure', () =>
  withRoot(async (root) => {
    await withEditorPublicationOwner({
      root,
      run: async (fd) => {
        const child = spawnSync(
          process.execPath,
          [
            '--eval',
            `
        import { strict as assert } from 'node:assert';
        import { requireEditorPublicationOwner, withEditorPublicationOwner } from ${JSON.stringify(moduleUrl)};
        const root = ${JSON.stringify(root)};
        assert.equal(requireEditorPublicationOwner({ root }), 3);
        assert.equal(await withEditorPublicationOwner({ root, run: async fd => fd }), 3);
        await assert.rejects(withEditorPublicationOwner({ root, run: async fd => {
          assert.equal(fd, 3); throw new Error('borrowed failure');
        } }), /borrowed failure/);
        assert.equal(requireEditorPublicationOwner({ root }), 3);
      `,
          ],
          {
            env: { ...process.env, [editorPublicationOwnerFdEnv]: '3' },
            stdio: ['ignore', 'pipe', 'pipe', fd],
            encoding: 'utf8',
          },
        )
        expect({
          status: child.status,
          signal: child.signal,
          stderr: child.stderr,
          error: child.error,
        }).toEqual({
          status: 0,
          signal: null,
          stderr: '',
          error: undefined,
        })
        expect(canAcquire(root)).toBe(false)
      },
    })
    expect(canAcquire(root)).toBe(true)
  }))

it('retains real contention until the last inherited descendant is interrupted and reaped', () =>
  withRoot(async (root) => {
    let child: ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    try {
      await withEditorPublicationOwner({
        root,
        run: async (fd) => {
          child = spawn(
            process.execPath,
            [
              '--eval',
              `
          import { requireEditorPublicationOwner } from ${JSON.stringify(moduleUrl)};
          requireEditorPublicationOwner({ root: ${JSON.stringify(root)} });
          process.stdin.resume(); process.stdout.write('owned');
        `,
            ],
            {
              env: { ...process.env, [editorPublicationOwnerFdEnv]: '3' },
              stdio: ['pipe', 'pipe', 'pipe', fd],
              timeout: 10000,
            },
          )
          const closed = Promise.withResolvers<unknown>()
          exited = closed.promise
          child.once('error', closed.reject)
          child.once('exit', (code, signal) => closed.resolve({ code, signal }))
          const ready = Promise.withResolvers<void>()
          child.stdout!.once('data', () => ready.resolve())
          child.once('error', ready.reject)
          child.once('exit', () =>
            ready.reject(new Error('descendant exited before ownership acknowledgement')),
          )
          await ready.promise
          expect(canAcquire(root)).toBe(false)
        },
      })
      expect(canAcquire(root)).toBe(false)
      child!.kill('SIGTERM')
      await exited
      expect(canAcquire(root)).toBe(true)
    } finally {
      child?.kill('SIGKILL')
      await exited
    }
  }))
