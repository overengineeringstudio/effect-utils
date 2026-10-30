import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from 'node:fs'
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

describe('verified private lease preload', () => {
  const installer = new URL('../nix/editor-view-lease/prepare-preload.sh', import.meta.url).pathname
  const install = (directory: string) =>
    spawnSync('bash', [installer, preload], {
      env: { ...cleanEnvironment(), XDG_RUNTIME_DIR: directory, TMPDIR: directory },
      encoding: 'utf8',
    })
  it('the real source launcher exports the same verified copy to every consumer', () => {
    const directory = fixture()
    const launcher = process.env.EDITOR_VIEW_SOURCE_LAUNCHER
    if (launcher === undefined) throw new Error('EDITOR_VIEW_SOURCE_LAUNCHER is required')
    const result = spawnSync(
      launcher,
      [
        process.execPath,
        '-e',
        'console.log(JSON.stringify([process.env.EDITOR_VIEW_LEASE_PRELOAD, process.env.NODE_OPTIONS, process.env.BUN_OPTIONS]))',
      ],
      {
        env: { ...cleanEnvironment(), XDG_RUNTIME_DIR: directory, TMPDIR: directory },
        encoding: 'utf8',
      },
    )
    expect(result.status).toBe(0)
    const [path, nodeOptions, bunOptions] = JSON.parse(result.stdout)
    expect(path.startsWith('/nix/store/')).toBe(false)
    expect(readFileSync(path)).toEqual(readFileSync(preload))
    expect(nodeOptions).toContain(`--require=${path}`)
    expect(bunOptions).toContain(`--preload=${path}`)
  })
  it('publishes the expected hash outside the store and refuses subsequent tampering', () => {
    const directory = fixture()
    const result = install(directory)
    expect(result.status).toBe(0)
    const path = result.stdout.trim()
    const digest = createHash('sha256').update(readFileSync(preload)).digest('hex')
    expect(path).toBe(join(directory, 'editor-view-lease', `preload-${digest}.cjs`))
    expect(path.startsWith('/nix/store/')).toBe(false)
    expect(readFileSync(path)).toEqual(readFileSync(preload))
    expect(statSync(path).mode & 0o777).toBe(0o444)
    expect(statSync(join(directory, 'editor-view-lease')).mode & 0o777).toBe(0o700)
    chmodSync(path, 0o644)
    writeFileSync(path, 'tampered')
    chmodSync(path, 0o444)
    const refused = install(directory)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('untrusted preload hash')
    expect(refused.stdout).toBe('')
  })
  it('concurrent installers converge on the same verified file', async () => {
    const directory = fixture()
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn('bash', [installer, preload], {
              env: { ...cleanEnvironment(), XDG_RUNTIME_DIR: directory, TMPDIR: directory },
            })
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', (chunk) => {
              stdout += chunk
            })
            child.stderr.on('data', (chunk) => {
              stderr += chunk
            })
            child.on('error', reject)
            child.on('close', (code) => {
              if (code === 0) resolve(stdout.trim())
              else reject(new Error(stderr))
            })
          }),
      ),
    )
    expect(new Set(results).size).toBe(1)
    expect(readFileSync(results[0]!)).toEqual(readFileSync(preload))
  })
  for (const mode of [0o720, 0o702]) {
    it(`refuses a writable runtime directory (${mode.toString(8)})`, () => {
      const directory = fixture()
      chmodSync(directory, mode)
      const result = install(directory)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('untrusted preload directory')
    })
  }
  it.skipIf(process.getuid?.() === 0)('refuses a runtime directory owned by another user', () => {
    expect(install('/usr').status).not.toBe(0)
  })
  it('refuses a symlink instead of a content-addressed regular file', () => {
    const directory = fixture()
    const result = install(directory)
    const path = result.stdout.trim()
    expect(result.status).toBe(0)
    rmSync(path)
    symlinkSync(preload, path)
    expect(install(directory).status).not.toBe(0)
  })
  it('refuses an existing writable preload even when its bytes match', () => {
    const directory = fixture()
    const result = install(directory)
    expect(result.status).toBe(0)
    chmodSync(result.stdout.trim(), 0o644)
    const refused = install(directory)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('untrusted preload mode')
  })
})

// Exercise actual descriptor passing, not just the parent's lifetime or an env
// variable containing a pathname. Native lock semantics have their own suite.
describe('bootstrap-safe source consumer descriptor handoff', () => {
  it('root release uses bootstrap Bun rather than acquiring its own conflicting reader lease', () => {
    const config = readFileSync(new URL('../devenv.nix', import.meta.url), 'utf8')
    const release = config.slice(
      config.indexOf('tasks."buck2:editor:release"'),
      config.indexOf('tasks."buck2:typescript:materialize-dist"'),
    )
    expect(release).toContain('${pkgs.bun}/bin/bun')
    expect(release).not.toContain('${sourceBun}/bin/bun')
  })
  it('leaf readers retain descriptors without compiling an unused native spawn binding', () => {
    const directory = fixture()
    const payload = join(directory, 'generation')
    writeFileSync(payload, 'leaf-generation')
    const fd = openSync(payload, 'r')
    try {
      const result = spawnSync(
        'env',
        [
          '-u',
          'NODE_OPTIONS',
          '-u',
          'BUN_OPTIONS',
          'EDITOR_VIEW_LEASE_FDS=3',
          `EDITOR_VIEW_LEASE_LIBRARY=${join(directory, 'unused-native-library')}`,
          process.execPath,
          '--require',
          preload,
          '-e',
          inheritedRead,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe', fd],
          env: {
            ...cleanEnvironment(),
            EDITOR_VIEW_LEASE_FDS: '3',
            EDITOR_VIEW_LEASE_LIBRARY: join(directory, 'unused-native-library'),
          },
          timeout: 10_000,
        },
      )
      expect(result.status).toBe(0)
      expect(result.stderr?.toString()).toBe('')
      expect(result.stdout?.toString()).toBe('leaf-generation')
    } finally {
      closeSync(fd)
    }
  })
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
        const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
        if (library === undefined)
          throw new Error('EDITOR_VIEW_LEASE_LIBRARY is required for source inheritance tests')
        const directory = fixture()
        const payload = join(directory, 'generation')
        const child = join(directory, 'child.cjs')
        writeFileSync(payload, 'admitted-generation')
        writeFileSync(
          child,
          `${inheritedRead}; process.stdout.write('\\n' + process.env.EDITOR_VIEW_LEASE_LIBRARY)`,
        )
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
          expect(result.stdout?.toString()).toBe(`admitted-generation\n${library}`)
        } finally {
          closeSync(fd)
        }
      })
    }
  }

  for (const runtime of ['node', 'bun']) {
    it(`${runtime} spawnSync preserves inherited runtime options without an explicit env`, () => {
      const executable = runtime === 'bun' ? process.execPath : Bun.which('node')
      if (executable === null)
        throw new Error('Node is required for editor-view source inheritance tests')
      const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
      if (library === undefined)
        throw new Error('EDITOR_VIEW_LEASE_LIBRARY is required for source inheritance tests')
      const directory = fixture()
      const payload = join(directory, 'generation')
      const runtimeFlag = join(directory, 'runtime-flag.cjs')
      const child = join(directory, 'child.cjs')
      writeFileSync(payload, 'admitted-generation')
      writeFileSync(runtimeFlag, `globalThis.editorViewRuntimeFlag = 'preserved'`)
      writeFileSync(
        child,
        `${inheritedRead}; process.stdout.write('\\n' + JSON.stringify({
          runtimeFlag: globalThis.editorViewRuntimeFlag,
          nodeOptions: process.env.NODE_OPTIONS,
          bunOptions: process.env.BUN_OPTIONS,
          leaseFds: process.env.EDITOR_VIEW_LEASE_FDS,
        }))`,
      )
      const nodeOptions = `--require=${runtimeFlag}`
      const bunOptions = `--preload=${runtimeFlag}`
      const fd = openSync(payload, 'r')
      try {
        const result = spawnSync(
          'env',
          [
            '-u',
            'NODE_OPTIONS',
            '-u',
            'BUN_OPTIONS',
            'EDITOR_VIEW_LEASE_FDS=3',
            `NODE_OPTIONS=${nodeOptions}`,
            `BUN_OPTIONS=${bunOptions}`,
            executable,
            '--require',
            preload,
            '-e',
            `const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(child)}], {
              stdio: ['ignore', 'pipe', 'inherit', 'ignore'],
            }); if (result.error) throw result.error; process.stdout.write(result.stdout); process.exitCode = result.status`,
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe', fd],
            env: {
              ...cleanEnvironment(),
              EDITOR_VIEW_LEASE_FDS: '3',
              EDITOR_VIEW_LEASE_LIBRARY: library,
              NODE_OPTIONS: nodeOptions,
              BUN_OPTIONS: bunOptions,
            },
            timeout: 10_000,
          },
        )
        expect(result.error).toBeUndefined()
        expect(result.stderr?.toString()).toBe('')
        expect(result.status).toBe(0)
        const [generation, flags] = result.stdout!.toString().split('\n')
        expect(generation).toBe('admitted-generation')
        expect(JSON.parse(flags!)).toEqual({
          runtimeFlag: 'preserved',
          nodeOptions: `${nodeOptions} --require=${preload}`,
          bunOptions: `${bunOptions} --preload=${preload}`,
          leaseFds: '4',
        })
      } finally {
        closeSync(fd)
      }
    })
  }

  it('Node -> Bun -> execve -> Bun spawn retains only leases and standard IO', () => {
    const node = Bun.which('node')
    if (node === null) throw new Error('Node is required for editor-view source inheritance tests')
    const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
    if (library === undefined)
      throw new Error('EDITOR_VIEW_LEASE_LIBRARY is required for source inheritance tests')
    const directory = fixture()
    const payload = join(directory, 'generation')
    const unrelated = join(directory, 'unrelated')
    const replacement = join(directory, 'replace.cjs')
    writeFileSync(payload, 'retained-across-execve')
    writeFileSync(unrelated, 'must-not-survive')
    writeFileSync(
      replacement,
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      if (!process.env.REPLACED_PID) {
        const mapping = process.env.EDITOR_VIEW_LEASE_FDS;
        const identities = mapping.split(',').map(fd => fs.fstatSync(+fd).ino);
        const unrelated = fs.fstatSync(3).ino;
        process.execve(process.execPath, [process.execPath, __filename], {
          PATH: process.env.PATH, REPLACED_PID: String(process.pid),
          EXPECTED_MAPPING: mapping, EXPECTED_IDENTITIES: JSON.stringify(identities),
          UNRELATED_IDENTITY: String(unrelated), CUSTOM_ENV: 'preserved',
        });
      }
      assert.equal(String(process.pid), process.env.REPLACED_PID);
      assert.equal(process.env.CUSTOM_ENV, 'preserved');
      assert.equal(process.env.EDITOR_VIEW_LEASE_FDS, process.env.EXPECTED_MAPPING);
      assert.deepEqual(process.env.EDITOR_VIEW_LEASE_FDS.split(',').map(fd => fs.fstatSync(+fd).ino),
        JSON.parse(process.env.EXPECTED_IDENTITIES));
      let unrelated;
      try { unrelated = String(fs.fstatSync(3).ino); } catch (error) { assert.equal(error.code, 'EBADF'); }
      assert.notEqual(unrelated, process.env.UNRELATED_IDENTITY);
      assert.equal(fs.readFileSync(0, 'utf8'), 'retained stdin');
      const result = Bun.spawnSync([process.execPath, '-e', ${JSON.stringify(inheritedRead)}], { stdout: 'pipe', stderr: 'pipe' });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      process.stderr.write('retained stderr');
      process.stdout.write(result.stdout);
    `,
    )
    const fd = openSync(payload, 'r')
    try {
      const result = spawnSync(
        'env',
        [
          '-u',
          'NODE_OPTIONS',
          '-u',
          'BUN_OPTIONS',
          'EDITOR_VIEW_LEASE_FDS=3',
          'EDITOR_VIEW_LEASE_ACTIVE=1',
          node,
          '--require',
          preload,
          '-e',
          `
          const fs = require('node:fs');
          const cp = require('node:child_process');
          const unrelated = fs.openSync(${JSON.stringify(unrelated)}, 'r');
          const child = cp.spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(replacement)}], {
            stdio: ['pipe', 'pipe', 'pipe', unrelated],
          });
          fs.closeSync(unrelated);
          child.stdin.end('retained stdin');
          child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
          child.on('close', code => { process.exitCode = code; });
        `,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe', fd],
          env: { ...cleanEnvironment(), EDITOR_VIEW_LEASE_LIBRARY: library },
          timeout: 10_000,
        },
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr?.toString()).toBe(0)
      expect(result.stderr?.toString()).toBe('retained stderr')
      expect(result.stdout?.toString()).toBe('retained-across-execve')
    } finally {
      closeSync(fd)
    }
  })

  it.each([
    ['inactive', '', '3'],
    ['empty', '1', ''],
    ['closed', '1', '2147483647'],
  ])('leaves Bun execve unchanged for an %s lease mapping', (_name, active, mapping) => {
    const directory = fixture()
    const payload = join(directory, 'generation')
    writeFileSync(payload, 'generation')
    const fd = openSync(payload, 'r')
    try {
      const result = spawnSync(
        'env',
        [
          '-u',
          'NODE_OPTIONS',
          '-u',
          'BUN_OPTIONS',
          `EDITOR_VIEW_LEASE_ACTIVE=${active}`,
          `EDITOR_VIEW_LEASE_FDS=${mapping}`,
          process.execPath,
          '-e',
          `
          const original = process.execve;
          require(${JSON.stringify(preload)});
          require('node:assert/strict').equal(process.execve, original);
        `,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe', fd],
          env: {
            ...cleanEnvironment(),
            EDITOR_VIEW_LEASE_LIBRARY: join(directory, 'unused-library'),
          },
          timeout: 10_000,
        },
      )
      expect(result.status).toBe(0)
      expect(result.stderr?.toString()).toBe('')
    } finally {
      closeSync(fd)
    }
  })

  it('reports native execve errno without dropping the lease or running a fallback', () => {
    const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
    if (library === undefined)
      throw new Error('EDITOR_VIEW_LEASE_LIBRARY is required for source inheritance tests')
    const directory = fixture()
    const payload = join(directory, 'generation')
    const missing = join(directory, 'missing')
    const unrelated = join(directory, 'unrelated')
    writeFileSync(payload, 'generation')
    writeFileSync(unrelated, 'unrelated')
    const fd = openSync(payload, 'r')
    const unrelatedFd = openSync(unrelated, 'r')
    try {
      const result = spawnSync(
        'env',
        [
          '-u',
          'NODE_OPTIONS',
          '-u',
          'BUN_OPTIONS',
          'EDITOR_VIEW_LEASE_FDS=3',
          'EDITOR_VIEW_LEASE_ACTIVE=1',
          process.execPath,
          '--require',
          preload,
          '-e',
          `
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          const before = fs.fstatSync(3).ino;
          const native = require('bun:ffi').dlopen(process.env.EDITOR_VIEW_LEASE_LIBRARY, {
            eu_getfd: { args: ['i32'], returns: 'i32' },
          });
          const libc = require('bun:ffi').dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
            dup: { args: ['i32'], returns: 'i32' },
          });
          // dup creates a real non-CLOEXEC descriptor after Bun's startup.
          const unrelatedCopy = libc.symbols.dup(4);
          assert.ok(unrelatedCopy >= 3);
          const leaseFlags = native.symbols.eu_getfd(3);
          assert.equal(native.symbols.eu_getfd(unrelatedCopy), 0, 'unrelated descriptor starts without CLOEXEC');
          assert.throws(() => process.execve(${JSON.stringify(missing)}, ['argv0'], {}), error =>
            error.errno === 2 && error.code === 'ENOENT' && error.syscall === 'execve' &&
            error.path === ${JSON.stringify(missing)});
          assert.equal(fs.fstatSync(3).ino, before);
          assert.equal(native.symbols.eu_getfd(3), leaseFlags);
          assert.equal(native.symbols.eu_getfd(unrelatedCopy), 0, 'failed exec restores unrelated descriptor flags');
          native.close();
          fs.closeSync(unrelatedCopy); libc.close();
        `,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe', fd, unrelatedFd],
          env: { ...cleanEnvironment(), EDITOR_VIEW_LEASE_LIBRARY: library },
          timeout: 10_000,
        },
      )
      expect(result.status, result.stderr?.toString()).toBe(0)
      expect(result.stderr?.toString()).toBe('')
    } finally {
      closeSync(fd)
      closeSync(unrelatedFd)
    }
  })

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
