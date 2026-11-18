import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./listener-process.fixture.ts', import.meta.url))
const launch = (socketPath: string) => Bun.spawn([process.execPath, fixture, socketPath], {
  stdout: 'pipe', stderr: 'pipe',
})
const ready = async (child: ReturnType<typeof launch>) => {
  const reader = child.stdout.getReader()
  try {
    const output = await reader.read()
    expect(new TextDecoder().decode(output.value)).toContain('READY')
  } finally {
    reader.releaseLock()
  }
}
const probe = (socketPath: string) => new Promise<number>((resolve, reject) => {
  const call = request({ socketPath, path: '/missing', method: 'GET' }, (response) => {
    response.resume()
    response.once('end', () => resolve(response.statusCode!))
  })
  call.once('error', reject)
  call.end()
})

it('reclaims only its stale owned socket after SIGKILL and refuses a second live owner', async () => {
  // Unix sockaddr paths are bounded; a short private temp root is required even in long worktrees.
  const directory = realpathSync(mkdtempSync('/tmp/scg-socket-'))
  chmodSync(directory, 0o700)
  const socketPath = join(directory, 'ingress.sock')
  const children: ReturnType<typeof launch>[] = []
  try {
    const first = launch(socketPath)
    children.push(first)
    await ready(first)
    expect(await probe(socketPath)).toBe(404)
    const inode = lstatSync(socketPath).ino
    const competing = launch(socketPath)
    children.push(competing)
    expect(await competing.exited).toBe(1)
    expect(lstatSync(socketPath).ino).toBe(inode)
    expect(await probe(socketPath)).toBe(404)
    first.kill('SIGKILL')
    await first.exited
    expect(lstatSync(socketPath).isSocket()).toBe(true)
    const restarted = launch(socketPath)
    children.push(restarted)
    await ready(restarted)
    expect(await probe(socketPath)).toBe(404)
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o660)
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

it('refuses regular files, symlinks and unsafe ownership-directory permissions without unlinking', async () => {
  const directory = realpathSync(mkdtempSync('/tmp/scg-socket-'))
  const socketPath = join(directory, 'ingress.sock')
  const target = join(directory, 'target')
  try {
    writeFileSync(socketPath, 'must survive')
    expect(await launch(socketPath).exited).toBe(1)
    expect(readFileSync(socketPath, 'utf8')).toBe('must survive')
    rmSync(socketPath)
    writeFileSync(target, 'also survives')
    symlinkSync(target, socketPath)
    expect(await launch(socketPath).exited).toBe(1)
    expect(lstatSync(socketPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('also survives')
    rmSync(socketPath)
    chmodSync(directory, 0o770)
    expect(await launch(socketPath).exited).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('also survives')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

it('never unlinks a live listener that does not participate in its lifecycle lock', async () => {
  const directory = realpathSync(mkdtempSync('/tmp/scg-socket-'))
  const socketPath = join(directory, 'ingress.sock')
  const server = createServer((connection) => connection.end())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const inode = lstatSync(socketPath).ino
    expect(await launch(socketPath).exited).toBe(1)
    expect(lstatSync(socketPath).ino).toBe(inode)
    expect(server.listening).toBe(true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
