import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const preload = new URL('../nix/editor-view-lease/inherit.cjs', import.meta.url).pathname
const helpers = new URL('../nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh', import.meta.url)
  .pathname
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'editor-view-source-'))
  directories.push(directory)
  return directory
}
const cleanEnvironment = () => {
  const env = { ...process.env }
  for (const key of [
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'EDITOR_VIEW_LEASE_FDS',
    'EDITOR_VIEW_LEASE_ACTIVE',
  ])
    delete env[key]
  return env
}
const inheritedRead = `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(Number(process.env.EDITOR_VIEW_LEASE_FDS.split(',')[0]), 'utf8'))`

// Exercise actual descriptor passing, not just the parent's lifetime or an env
// variable containing a pathname. Native lock semantics have their own suite.
describe('bootstrap-safe source consumer descriptor handoff', () => {
  for (const runtime of ['node', 'bun']) {
    for (const method of [
      'spawn',
      'spawnSync',
      'execFileSync',
      'fork',
      ...(runtime === 'bun' ? ['bunSpawn', 'bunSpawnSync'] : []),
    ]) {
      it(`${runtime} ${method} retains the descriptor with custom stdio and replacement env`, () => {
        const executable = runtime === 'bun' ? process.execPath : Bun.which('node')
        if (executable === null)
          throw new Error('Node is required for editor-view source inheritance tests')
        const directory = fixture()
        const payload = join(directory, 'generation')
        const child = join(directory, 'child.cjs')
        writeFileSync(payload, 'admitted-generation')
        writeFileSync(child, inheritedRead)
        const fd = openSync(payload, 'r')
        const program = `
          const cp = require('node:child_process');
          const options = {stdio: ['ignore', 'pipe', 'inherit', 'ignore'${method === 'fork' ? ", 'ipc'" : ''}], env: {PATH: process.env.PATH}};
          const child = ${JSON.stringify(child)};
          ${method === 'spawn' ? `cp.spawn(process.execPath, [child], options).stdout.pipe(process.stdout)` : ''}
          ${method === 'spawnSync' ? `const result = cp.spawnSync(process.execPath, [child], options); if (result.error) throw result.error; process.stdout.write(result.stdout); process.exitCode = result.status` : ''}
          ${method === 'execFileSync' ? `process.stdout.write(cp.execFileSync(process.execPath, [child], options))` : ''}
          ${method === 'fork' ? `cp.fork(child, [], options).stdout.pipe(process.stdout)` : ''}
          ${method === 'bunSpawn' ? `const result = Bun.spawn({cmd: [process.execPath, child], stdout: 'pipe', stderr: 'inherit', env: {PATH: process.env.PATH}}); new Response(result.stdout).text().then(value => process.stdout.write(value))` : ''}
          ${method === 'bunSpawnSync' ? `const result = Bun.spawnSync({cmd: [process.execPath, child], stdout: 'pipe', stderr: 'inherit', env: {PATH: process.env.PATH}}); process.stdout.write(result.stdout); process.exitCode = result.exitCode` : ''}
        `
        try {
          const result = spawnSync(
            'env',
            [
              '-u',
              'NODE_OPTIONS',
              '-u',
              'BUN_OPTIONS',
              'EDITOR_VIEW_LEASE_FDS=3',
              `NODE_OPTIONS=--require=${preload}`,
              executable,
              '--require',
              preload,
              '-e',
              program,
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe', fd],
              env: {
                ...cleanEnvironment(),
                EDITOR_VIEW_LEASE_FDS: '3',
                NODE_OPTIONS: `--require=${preload}`,
              },
              timeout: 10_000,
            },
          )
          expect(result.error).toBeUndefined()
          expect(result.stderr?.toString()).toBe('')
          expect(result.status).toBe(0)
          expect(result.stdout?.toString()).toBe('admitted-generation')
        } finally {
          closeSync(fd)
        }
      })
    }
  }

  it('the actual child retains its descriptor after parent SIGKILL', () => {
    const node = Bun.which('node')
    if (node === null) throw new Error('Node is required for editor-view source inheritance tests')
    const directory = fixture()
    const payload = join(directory, 'generation')
    writeFileSync(payload, 'retained-after-parent-death')
    const fd = openSync(payload, 'r')
    try {
      const grandchild = `process.kill(process.ppid, 'SIGKILL'); ${inheritedRead}`
      const result = spawnSync(
        'env',
        [
          '-u',
          'NODE_OPTIONS',
          '-u',
          'BUN_OPTIONS',
          'EDITOR_VIEW_LEASE_FDS=3',
          `NODE_OPTIONS=--require=${preload}`,
          node,
          '--require',
          preload,
          '-e',
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: ['ignore', 'inherit', 'inherit']})`,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe', fd],
          env: {
            ...cleanEnvironment(),
            EDITOR_VIEW_LEASE_FDS: '3',
            NODE_OPTIONS: `--require=${preload}`,
          },
          timeout: 10_000,
        },
      )
      expect(result.signal).toBe('SIGKILL')
      expect(result.stdout?.toString()).toBe('retained-after-parent-death')
    } finally {
      closeSync(fd)
    }
  })

  it('a failed acquisition forbids package manifest resolution and source execution', () => {
    const directory = fixture()
    const marker = join(directory, 'imported')
    const reject = join(directory, 'reject-lease')
    const node = join(directory, 'must-not-resolve')
    writeFileSync(reject, '#!/bin/sh\nexit 73\n', { mode: 0o755 })
    writeFileSync(node, `#!/bin/sh\nprintf imported > '${marker}'\nexit 1\n`, { mode: 0o755 })
    const result = spawnSync(
      'bash',
      ['-c', 'source "$1"; run_package_bin missing missing', 'lease-consumer-test', helpers],
      {
        cwd: directory,
        env: { ...cleanEnvironment(), EDITOR_VIEW_SOURCE_LAUNCHER: reject, NODE_BIN: node },
        timeout: 10_000,
      },
    )
    expect(result.status).toBe(73)
    expect(existsSync(marker)).toBe(false)
  })
})
