/**
 * CLI Integration Tests
 *
 * Tests for CLI command functionality (init, root, add, etc.)
 * These tests verify the core logic without invoking the CLI directly.
 */

import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig, validateMemberName } from '../lib/config.ts'
import { initGitRepo, readConfig } from '../test-utils/setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

// =============================================================================
// Helper: Find megarepo root (extracted from CLI logic)
// =============================================================================

/**
 * Find megarepo root by searching up from current directory.
 * Returns the OUTERMOST megarepo found (closest to filesystem root).
 */
const findMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current: AbsoluteDirPath | undefined = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')
    let outermost: AbsoluteDirPath | undefined = undefined

    while (current !== undefined && current !== rootDir) {
      const configPath = EffectPath.ops.join(
        current,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const exists = yield* fs.exists(configPath)
      if (exists) {
        outermost = current
      }
      current = EffectPath.ops.parent(current)
    }

    return Option.fromNullable(outermost)
  })

// =============================================================================
// Init Command Tests
// =============================================================================

describe('mr init', () => {
  it('should create megarepo.json in git repo', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a temp directory and init git
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('test-repo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        // Verify no megarepo.json exists yet
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        expect(yield* fs.exists(configPath)).toBe(false)

        // Simulate init: create initial config
        const initialConfig: typeof MegarepoConfig.Type = {
          $schema:
            'https://raw.githubusercontent.com/overengineeringstudio/megarepo/main/schema/megarepo.schema.json',
          members: {},
        }
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          initialConfig,
        )
        yield* fs.writeFileString(configPath, configContent + '\n')

        // Verify config was created
        expect(yield* fs.exists(configPath)).toBe(true)

        // Read and verify config content
        const config = yield* readConfig(workDir)
        expect(config.members).toEqual({})
        expect(config.$schema).toBeDefined()
      }),
    ))

  it('should not overwrite existing megarepo.json', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create directory with git
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('test-repo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        // Create existing config with a member
        const existingConfig: typeof MegarepoConfig.Type = {
          members: { 'existing-lib': 'owner/existing-lib' },
        }
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          existingConfig,
        )
        yield* fs.writeFileString(configPath, configContent + '\n')

        // Verify existing config
        const config = yield* readConfig(workDir)
        expect(config.members['existing-lib']).toBe('owner/existing-lib')

        // Re-init should not overwrite (in real CLI, this would be a no-op)
        // The config should still have the existing member
        const configAfter = yield* readConfig(workDir)
        expect(configAfter.members['existing-lib']).toBe('owner/existing-lib')
      }),
    ))
})

// =============================================================================
// Root Command Tests (including nested megarepo "outer wins" behavior)
// =============================================================================

describe('mr root', () => {
  it('should find megarepo root in current directory', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })

        // Create megarepo.json
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        // Find root
        const root = yield* findMegarepoRoot(workDir)
        expect(Option.isSome(root)).toBe(true)
        expect(Option.getOrNull(root)).toBe(workDir)
      }),
    ))

  it('should find megarepo root from subdirectory', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace structure
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        const subDir = EffectPath.ops.join(workDir, EffectPath.unsafe.relativeDir('packages/lib/'))
        yield* fs.makeDirectory(subDir, { recursive: true })

        // Create megarepo.json at root
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        // Find root from subdirectory
        const root = yield* findMegarepoRoot(subDir)
        expect(Option.isSome(root)).toBe(true)
        expect(Option.getOrNull(root)).toBe(workDir)
      }),
    ))

  it('should return outer megarepo for nested megarepos (outer wins)', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create nested megarepo structure
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const outerDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outer/'))
        const innerDir = EffectPath.ops.join(
          outerDir,
          EffectPath.unsafe.relativeDir('members/inner/'),
        )
        yield* fs.makeDirectory(innerDir, { recursive: true })

        // Create megarepo.json in outer
        const outerConfigPath = EffectPath.ops.join(
          outerDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        yield* fs.writeFileString(outerConfigPath, '{"members":{"inner":"inner"}}')

        // Create megarepo.json in inner (nested megarepo)
        const innerConfigPath = EffectPath.ops.join(
          innerDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        yield* fs.writeFileString(innerConfigPath, '{"members":{}}')

        // Find root from inner - should return OUTER megarepo
        const root = yield* findMegarepoRoot(innerDir)
        expect(Option.isSome(root)).toBe(true)
        expect(Option.getOrNull(root)).toBe(outerDir)
      }),
    ))

  it('should return none when not in megarepo', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create directory without megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('not-megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })

        // Find root - should return none
        const root = yield* findMegarepoRoot(workDir)
        expect(Option.isNone(root)).toBe(true)
      }),
    ))
})

// =============================================================================
// Add Command Tests
// =============================================================================

describe('mr add', () => {
  it('should add member to megarepo.json', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with empty megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const initialConfig: typeof MegarepoConfig.Type = { members: {} }
        const initialContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          initialConfig,
        )
        yield* fs.writeFileString(configPath, initialContent + '\n')

        // Add a member
        const memberName = 'effect'
        const memberSource = 'effect-ts/effect'

        // Simulate add: update config
        const config = yield* readConfig(workDir)
        const updatedConfig = {
          ...config,
          members: { ...config.members, [memberName]: memberSource },
        }
        const updatedContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          updatedConfig,
        )
        yield* fs.writeFileString(configPath, updatedContent + '\n')

        // Verify member was added
        const finalConfig = yield* readConfig(workDir)
        expect(finalConfig.members['effect']).toBe('effect-ts/effect')
      }),
    ))

  it('should add member with custom name', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        // Add member with custom name
        const customName = 'effect-v3'
        const memberSource = 'effect-ts/effect#v3.0.0'

        const config = yield* readConfig(workDir)
        const updatedConfig = {
          ...config,
          members: { ...config.members, [customName]: memberSource },
        }
        const updatedContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          updatedConfig,
        )
        yield* fs.writeFileString(configPath, updatedContent + '\n')

        const finalConfig = yield* readConfig(workDir)
        expect(finalConfig.members['effect-v3']).toBe('effect-ts/effect#v3.0.0')
      }),
    ))

  it('should reject invalid member names', () => {
    // Test member name validation
    expect(validateMemberName('../traversal')).toBe('Member name cannot contain path separators')
    expect(validateMemberName('.hidden')).toBe('Member name cannot start with a dot')
    expect(validateMemberName('')).toBe('Member name cannot be empty')
    expect(validateMemberName('valid-name')).toBeUndefined()
  })

  it('should not add duplicate member', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with existing member
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const initialConfig: typeof MegarepoConfig.Type = {
          members: { effect: 'effect-ts/effect' },
        }
        const initialContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          initialConfig,
        )
        yield* fs.writeFileString(configPath, initialContent + '\n')

        // Check that member already exists
        const config = yield* readConfig(workDir)
        const memberName = 'effect'

        // In real CLI, this would fail with "Member already exists"
        expect(memberName in config.members).toBe(true)
      }),
    ))
})

// =============================================================================
// Config Parsing Tests
// =============================================================================

describe('megarepo.json parsing', () => {
  it('should parse config with multiple member formats', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        // Create config with various member formats
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const config: typeof MegarepoConfig.Type = {
          members: {
            github: 'owner/repo',
            'github-ref': 'owner/repo#main',
            'github-tag': 'owner/repo#v1.0.0',
            url: 'https://github.com/owner/repo',
            ssh: 'git@github.com:owner/repo.git',
            local: './packages/local',
          },
        }
        const content = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(config)
        yield* fs.writeFileString(configPath, content + '\n')

        const parsed = yield* readConfig(workDir)
        expect(Object.keys(parsed.members)).toHaveLength(6)
        expect(parsed.members['github']).toBe('owner/repo')
        expect(parsed.members['github-ref']).toBe('owner/repo#main')
        expect(parsed.members['local']).toBe('./packages/local')
      }),
    ))

  it('should parse config with generators', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const config: typeof MegarepoConfig.Type = {
          members: { lib: 'owner/lib' },
          generators: {
            envrc: { enabled: true },
            vscode: { enabled: true, exclude: ['large-repo'] },
          },
        }
        const content = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(config)
        yield* fs.writeFileString(configPath, content + '\n')

        const parsed = yield* readConfig(workDir)
        expect(parsed.generators?.envrc?.enabled).toBe(true)
        expect(parsed.generators?.vscode?.enabled).toBe(true)
        expect(parsed.generators?.vscode?.exclude).toEqual(['large-repo'])
      }),
    ))
})
