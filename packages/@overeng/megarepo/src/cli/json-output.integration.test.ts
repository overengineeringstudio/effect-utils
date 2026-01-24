/**
 * JSON Output Integration Tests
 *
 * Smoke tests that verify the CLI's --json output works end-to-end.
 * The underlying JSON mode helpers are unit-tested in @overeng/utils.
 */

import path from 'node:path'
import url from 'node:url'

import { Command, FileSystem } from '@effect/platform'
import { Chunk, Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../lib/config.ts'
import { initGitRepo } from '../test-utils/setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

// Path to the CLI binary
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CLI_PATH = path.resolve(__dirname, '../../bin/mr.ts')

/** Decode collected chunks to string */
const decodeChunks = (chunks: Chunk.Chunk<Uint8Array>): string => {
  const merged = Chunk.reduce(chunks, new Uint8Array(), (acc, chunk) => {
    const result = new Uint8Array(acc.length + chunk.length)
    result.set(acc)
    result.set(chunk, acc.length)
    return result
  })
  return new TextDecoder().decode(merged)
}

/**
 * Run the CLI and capture stdout and stderr separately.
 * Returns { stdout, stderr, exitCode }
 */
const runCli = ({ cwd, args }: { cwd: AbsoluteDirPath; args: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const command = Command.make('bun', 'run', CLI_PATH, ...args).pipe(
      Command.workingDirectory(cwd),
      // Set PWD to match the working directory so the CLI uses the correct logical path
      Command.env({ PWD: cwd }),
      Command.stdout('pipe'),
      Command.stderr('pipe'),
    )

    // Run command and collect output
    const process = yield* Command.start(command)
    const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
      Stream.runCollect(process.stdout),
      Stream.runCollect(process.stderr),
      process.exitCode,
    ])

    return {
      stdout: decodeChunks(stdoutChunks),
      stderr: decodeChunks(stderrChunks),
      exitCode,
    }
  }).pipe(Effect.scoped)

/**
 * Asserts that stdout contains exactly one valid JSON object/array
 * and nothing else (no extra lines, no log output, etc.)
 */
const assertStdoutIsOnlyJson = (stdout: string) => {
  const trimmed = stdout.trim()

  // Should not be empty
  expect(trimmed.length).toBeGreaterThan(0)

  // Should parse as valid JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(
      `stdout is not valid JSON:\n---\n${stdout}\n---\nExpected valid JSON, got parse error`,
    )
  }

  // Should be an object or array (not a primitive)
  expect(typeof parsed).toBe('object')
  expect(parsed).not.toBeNull()

  // Additional check: ensure no ANSI codes leaked through
  // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for ANSI codes
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1B\[[0-9;]*[a-zA-Z]/.test(stdout)
  expect(hasAnsi).toBe(false)

  return parsed
}

/**
 * Create a test workspace with megarepo.json
 */
const createTestWorkspace = (members?: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('test-workspace/'))
    yield* fs.makeDirectory(workDir, { recursive: true })

    // Initialize as git repo
    yield* initGitRepo(workDir)

    // Create megarepo.json
    const config: typeof MegarepoConfig.Type = {
      members: members ?? {},
    }
    const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
      config,
    )
    yield* fs.writeFileString(
      EffectPath.ops.join(workDir, EffectPath.unsafe.relativeFile('megarepo.json')),
      configContent + '\n',
    )

    return workDir
  })

// =============================================================================
// Tests
// =============================================================================

describe('--json output (integration)', () => {
  it('outputs valid JSON on success', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workDir = yield* createTestWorkspace({
          'test-lib': 'owner/test-lib',
        })

        const result = yield* runCli({ cwd: workDir, args: ['ls', '--json'] })

        // Verify stdout is valid JSON only
        const json = assertStdoutIsOnlyJson(result.stdout) as {
          members: Record<string, string>
        }

        // Verify the JSON structure
        expect(json).toHaveProperty('members')
        expect(json.members).toHaveProperty('test-lib', 'owner/test-lib')

        // Verify stderr is empty (clean JSON mode has no stderr noise)
        expect(result.stderr.trim()).toBe('')
        expect(result.exitCode).toBe(0)
      }),
    ))

  it('outputs valid JSON on error', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a directory WITHOUT megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('not-megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const result = yield* runCli({
          cwd: workDir,
          args: ['root', '--json'],
        })

        // Verify stdout is still valid JSON even for errors
        const json = assertStdoutIsOnlyJson(result.stdout)

        // Verify error structure
        expect(json).toHaveProperty('error')
        expect(json).toHaveProperty('message')

        // Verify stderr is empty (clean JSON mode has no stderr noise)
        expect(result.stderr.trim()).toBe('')
        expect(result.exitCode).toBe(1)
      }),
    ))

  it('finds megarepo root when running from symlinked member directory', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a temp directory structure:
        // tmpDir/
        //   workspace/           <- megarepo root with megarepo.json
        //     megarepo.json
        //     repos/
        //       my-lib -> tmpDir/store/my-lib   <- symlink to store
        //   store/
        //     my-lib/            <- actual repo location (simulating the store)
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

        // Create workspace with megarepo.json
        const workspaceDir = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspaceDir, { recursive: true })
        yield* initGitRepo(workspaceDir)

        const config: typeof MegarepoConfig.Type = {
          members: { 'my-lib': 'owner/my-lib' },
        }
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          config,
        )
        yield* fs.writeFileString(
          EffectPath.ops.join(workspaceDir, EffectPath.unsafe.relativeFile('megarepo.json')),
          configContent + '\n',
        )

        // Create store directory with actual repo
        const storeDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('store/'))
        const storeRepoDir = EffectPath.ops.join(storeDir, EffectPath.unsafe.relativeDir('my-lib/'))
        yield* fs.makeDirectory(storeRepoDir, { recursive: true })
        yield* initGitRepo(storeRepoDir)

        // Create repos directory and symlink in workspace
        const reposDir = EffectPath.ops.join(workspaceDir, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })

        const symlinkPath = EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('my-lib'))
        // Symlink points to the store location (simulating how megarepo works)
        yield* fs.symlink(storeRepoDir.replace(/\/$/, ''), symlinkPath)

        // Run CLI from the symlinked directory (via $PWD)
        // The physical cwd will be storeRepoDir, but PWD will be the symlink path
        const symlinkDir = EffectPath.unsafe.absoluteDir(`${symlinkPath}/`)
        const result = yield* runCli({
          cwd: symlinkDir,
          args: ['root', '--json'],
        })

        // Should find the workspace's megarepo.json by following $PWD up
        const json = assertStdoutIsOnlyJson(result.stdout) as { root: string }

        expect(result.exitCode).toBe(0)
        expect(json).toHaveProperty('root')
        // The root should be the workspace directory (found via $PWD), not the store
        expect(json.root).toBe(workspaceDir)
      }),
    ))
})
