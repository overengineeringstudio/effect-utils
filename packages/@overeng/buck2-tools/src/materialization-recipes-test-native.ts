/* eslint-disable no-await-in-loop -- Cross-process filesystem handshakes, not elapsed-delay assertions. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import { editorViewTestDataRoot } from './editor-view-test-filesystem.ts'
import { parseMaterializationRecipe } from './materialization-recipes.ts'
import type { MaterializationRecipe } from './materialization-recipes.ts'

type NativeReplayResult = { code: number | null; stdout: string; stderr: string }
type NativeReplayProcess = {
  output: string
  receipt: string
  completed: Promise<NativeReplayResult>
  bridgeOperations: () => string[]
  release: () => void
  stop: () => boolean
  waitForVerification: () => Promise<void>
}
/** Real native process harness sharing the publisher's wire and lease contracts. */
export type NativeReplayHarness = {
  recipe: MaterializationRecipe
  dispose: () => void
  start: (input: {
    contentStore: string
    root: string
    name: string
    hold?: boolean
  }) => NativeReplayProcess
}

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(
      `native replay integration requires ${name}; this suite must not skip native coverage`,
    )
  return value
}
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const writableDirectories = (path: string): void => {
  if (lstatSync(path).isDirectory() === false) return
  chmodSync(path, 0o700)
  for (const name of readdirSync(path)) writableDirectories(join(path, name))
}

/** Real attested executables and the PR-built publisher runtime, never a fake native CLI. */
export const makeNativeReplayHarness = (): NativeReplayHarness => {
  const binary = realpathSync(required('BUCK2_ARCHIVE_TOOL_BIN'))
  const nativeManifest = realpathSync(required('BUCK2_ARCHIVE_TOOL_CAPABILITY_MANIFEST'))
  const bun = realpathSync(required('BUCK2_REPLAY_BUN_BIN'))
  const bunManifest = realpathSync(required('BUCK2_REPLAY_BUN_CAPABILITY_MANIFEST'))
  const sourceRuntime = realpathSync(required('BUCK2_REPLAY_PUBLISHER_RUNTIME'))
  const sourceEntry = realpathSync(required('BUCK2_REPLAY_PUBLISHER_ENTRY'))
  required('EDITOR_VIEW_LEASE_LIBRARY')
  const entry = relative(sourceRuntime, sourceEntry)
  if (entry === '' || entry.startsWith('../') === true || isAbsolute(entry) === true)
    throw new Error('publisher entry must be inside the declared runtime closure')
  const root = realpathSync(mkdtempSync(join(editorViewTestDataRoot(), 'buck-native-replay-')))
  try {
    const runtime = join(root, 'runtime')
    cpSync(sourceRuntime, runtime, { recursive: true })
    writableDirectories(runtime)
    // The wrapper does not replace the publisher: it awaits the real entry with
    // the real inherited exclusion fd. The handshake only holds its child exit,
    // at which point the native parent already owns the generation SH lease.
    const wrapper = join(runtime, 'native-replay-test-entry.mjs')
    writeFileSync(
      wrapper,
      `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const operation = process.argv[process.argv.indexOf('--operation') + 1]
appendFileSync(process.env.REPLAY_TEST_BRIDGE_LOG, operation + '\\n')
// The entry is selected by the PR-side runtime input, not known at author time.
await import(${JSON.stringify(`./${entry}`)})
if (operation === 'verify' && process.env.REPLAY_TEST_HOLD === '1') {
  writeFileSync(process.env.REPLAY_TEST_READY, 'verified\\n')
  const deadline = Date.now() + 20000
  // This waits for a cross-process filesystem handshake, not an elapsed delay.
  while (!existsSync(process.env.REPLAY_TEST_RELEASE)) {
    if (Date.now() > deadline) throw new Error('native replay test handshake timed out')
    await Bun.sleep(5)
  }
}
`,
    )
    const files: [string, string][] = []
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name)
        const status = lstatSync(path)
        if (status.isDirectory() === true) walk(path)
        else if (status.isFile() === true)
          files.push([relative(runtime, path), digest(readFileSync(path))])
        else throw new Error(`publisher runtime contains a nonregular entry: ${path}`)
      }
    }
    walk(runtime)
    files.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    const closure = digest(
      JSON.stringify([
        'effect-utils/buck-materialization-tool-closure/v1',
        digest(readFileSync(nativeManifest)),
        digest(readFileSync(bunManifest)),
        files,
      ]),
    )
    const inputs = join(root, 'inputs.json')
    writeFileSync(
      inputs,
      JSON.stringify({
        schema: 'effect-utils/buck-materialization-tool-inputs/v1',
        nativeManifest,
        bunManifest,
        publisherRuntime: runtime,
      }),
    )
    const config = join(root, 'bunfig.toml')
    writeFileSync(config, '')
    const recipe = parseMaterializationRecipe([
      'effect-utils/buck-materialization-recipe/v1',
      closure,
      'b'.repeat(64),
      'package',
      [],
    ])
    return {
      recipe,
      dispose: () => rmSync(root, { recursive: true, force: true }),
      start: ({ contentStore, root: fixtureRoot, name, hold = false }) => {
        const output = join(fixtureRoot, `${name}-output`)
        const receipt = join(fixtureRoot, `${name}-receipt.json`)
        const log = join(fixtureRoot, `${name}-bridge.log`)
        const ready = join(fixtureRoot, `${name}-ready`)
        const release = join(fixtureRoot, `${name}-release`)
        const child = spawn(
          binary,
          [
            '--capability-manifest',
            nativeManifest,
            'extract-npm',
            // A warm replay must not even open the acquisition artifact.
            '--archive',
            join(fixtureRoot, 'intentionally-absent.tgz'),
            '--out',
            output,
            '--strip-prefix',
            'package',
            '--content-store',
            contentStore,
            '--high-water-bytes',
            String(2 ** 30),
            '--archive-sha256',
            recipe[2],
            '--tool-closure-inputs',
            inputs,
            '--publisher-bun',
            bun,
            '--publisher-bun-config',
            config,
            '--publisher-entry',
            wrapper,
            '--receipt',
            receipt,
          ],
          {
            env: {
              ...process.env,
              REPLAY_TEST_BRIDGE_LOG: log,
              REPLAY_TEST_HOLD: hold === true ? '1' : '0',
              REPLAY_TEST_READY: ready,
              REPLAY_TEST_RELEASE: release,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (bytes: Buffer) => {
          stdout += bytes.toString()
        })
        child.stderr.on('data', (bytes: Buffer) => {
          stderr += bytes.toString()
        })
        // A watchdog bounds broken child processes; assertions await process exit
        // or the explicit publisher handshake, never this timer.
        const timer = setTimeout(() => child.kill('SIGKILL'), 25000)
        const completed = new Promise<NativeReplayResult>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code) => resolve({ code, stdout, stderr }))
        }).finally(() => clearTimeout(timer))
        // Keep a rejected spawn promise observed even while awaiting the handshake.
        void completed.catch(() => {})
        return {
          output,
          receipt,
          completed,
          bridgeOperations: () =>
            existsSync(log) === true ? readFileSync(log, 'utf8').trim().split('\n') : [],
          release: () => writeFileSync(release, ''),
          stop: () => child.kill('SIGKILL'),
          waitForVerification: async () => {
            const deadline = Date.now() + 15000
            // This observes a real child-process signal; fake timers cannot
            // deliver filesystem writes performed by the native/Bun pair.
            while (existsSync(ready) === false) {
              if (child.exitCode !== null || child.signalCode !== null)
                throw new Error(`native replay exited before verification handshake: ${stderr}`)
              if (Date.now() > deadline)
                throw new Error(`native replay verification handshake timed out: ${stderr}`)
              await Bun.sleep(5)
            }
          },
        }
      },
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
