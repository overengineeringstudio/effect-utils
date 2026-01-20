import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_FILE_NAME,
  DEFAULT_STORE_PATH,
  ENV_VARS,
  generateJsonSchema,
  getStorePath,
  MegarepoConfig,
  MemberConfig,
  parseMemberSource,
} from './config.ts'

describe('config', () => {
  describe('constants', () => {
    it('should have correct config file name', () => {
      expect(CONFIG_FILE_NAME).toBe('megarepo.json')
    })

    it('should have correct default store path', () => {
      expect(DEFAULT_STORE_PATH).toBe('~/.megarepo')
    })

    it('should have correct environment variable names', () => {
      expect(ENV_VARS.ROOT).toBe('MEGAREPO_ROOT')
      expect(ENV_VARS.STORE).toBe('MEGAREPO_STORE')
      expect(ENV_VARS.MEMBERS).toBe('MEGAREPO_MEMBERS')
    })
  })

  describe('parseMemberSource', () => {
    it('should parse github shorthand', () => {
      const config = new MemberConfig({ github: 'owner/repo' })
      const source = parseMemberSource(config)
      expect(source).toEqual({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
      })
    })

    it('should return undefined for invalid github shorthand', () => {
      const config = new MemberConfig({ github: 'invalid' })
      const source = parseMemberSource(config)
      expect(source).toBeUndefined()
    })

    it('should return undefined for empty github shorthand', () => {
      const config = new MemberConfig({ github: '' })
      const source = parseMemberSource(config)
      expect(source).toBeUndefined()
    })

    it('should parse url source', () => {
      const config = new MemberConfig({ url: 'git@github.com:owner/repo.git' })
      const source = parseMemberSource(config)
      expect(source).toEqual({
        type: 'url',
        url: 'git@github.com:owner/repo.git',
      })
    })

    it('should parse path source', () => {
      const config = new MemberConfig({ path: '/some/local/path' })
      const source = parseMemberSource(config)
      expect(source).toEqual({
        type: 'path',
        path: '/some/local/path',
      })
    })

    it('should prioritize github over url', () => {
      const config = new MemberConfig({
        github: 'owner/repo',
        url: 'git@github.com:other/repo.git',
      })
      const source = parseMemberSource(config)
      expect(source).toEqual({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
      })
    })

    it('should prioritize url over path', () => {
      const config = new MemberConfig({
        url: 'git@github.com:owner/repo.git',
        path: '/local/path',
      })
      const source = parseMemberSource(config)
      expect(source).toEqual({
        type: 'url',
        url: 'git@github.com:owner/repo.git',
      })
    })

    it('should return undefined when no source specified', () => {
      const config = new MemberConfig({})
      const source = parseMemberSource(config)
      expect(source).toBeUndefined()
    })

    it('should handle config with only pin/isolated options', () => {
      const config = new MemberConfig({ pin: 'v1.0.0', isolated: 'feature' })
      const source = parseMemberSource(config)
      expect(source).toBeUndefined()
    })
  })

  describe('getStorePath', () => {
    // Note: getStorePath now returns RelativeDirPath which always has a trailing slash
    it('should generate path for github source', () => {
      const path = getStorePath({ type: 'github', owner: 'owner', repo: 'repo' })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for ssh url', () => {
      const path = getStorePath({ type: 'url', url: 'git@github.com:owner/repo.git' })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for https url', () => {
      const path = getStorePath({ type: 'url', url: 'https://github.com/owner/repo.git' })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for https url without .git suffix', () => {
      const path = getStorePath({ type: 'url', url: 'https://github.com/owner/repo' })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for gitlab ssh url', () => {
      const path = getStorePath({ type: 'url', url: 'git@gitlab.com:owner/repo.git' })
      expect(path).toBe('gitlab.com/owner/repo/')
    })

    it('should handle unknown url formats with fallback', () => {
      const path = getStorePath({ type: 'url', url: 'some-weird-url/repo.git' })
      expect(path).toBe('other/repo/')
    })

    it('should generate path for local path', () => {
      const path = getStorePath({ type: 'path', path: '/some/local/my-repo' })
      expect(path).toBe('local/my-repo/')
    })

    it('should handle path with trailing slash', () => {
      const path = getStorePath({ type: 'path', path: '/some/local/my-repo/' })
      // Note: split('/').pop() on 'a/b/' returns '', so this tests edge case
      expect(path).toBe('local//')
    })
  })

  describe('MegarepoConfig schema', () => {
    it('should decode valid config', () => {
      const input = {
        members: {
          'effect-utils': { github: 'overengineeringstudio/effect-utils' },
        },
      }
      const result = Schema.decodeUnknownSync(MegarepoConfig)(input)
      expect(result.members['effect-utils']?.github).toBe('overengineeringstudio/effect-utils')
    })

    it('should decode config with all member options', () => {
      const input = {
        members: {
          repo1: { github: 'owner/repo', pin: 'v1.0.0' },
          repo2: { url: 'git@github.com:owner/repo.git', isolated: 'feature' },
          repo3: { path: '/local/path' },
        },
      }
      const result = Schema.decodeUnknownSync(MegarepoConfig)(input)
      expect(result.members['repo1']?.pin).toBe('v1.0.0')
      expect(result.members['repo2']?.isolated).toBe('feature')
      expect(result.members['repo3']?.path).toBe('/local/path')
    })

    it('should decode config with generators', () => {
      const input = {
        members: {},
        generators: {
          vscode: { enabled: true, exclude: ['docs'] },
          flake: { skip: ['internal'] },
        },
      }
      const result = Schema.decodeUnknownSync(MegarepoConfig)(input)
      expect(result.generators?.vscode?.enabled).toBe(true)
      expect(result.generators?.vscode?.exclude).toEqual(['docs'])
      expect(result.generators?.flake?.skip).toEqual(['internal'])
    })

    it('should decode config with $schema field', () => {
      const input = {
        $schema: './schema/megarepo.schema.json',
        members: {},
      }
      const result = Schema.decodeUnknownSync(MegarepoConfig)(input)
      expect(result.$schema).toBe('./schema/megarepo.schema.json')
    })

    it('should reject config without members', () => {
      const input = {}
      expect(() => Schema.decodeUnknownSync(MegarepoConfig)(input)).toThrow()
    })
  })

  describe('generateJsonSchema', () => {
    it('should generate valid JSON schema', () => {
      const schema = generateJsonSchema() as unknown as Record<string, unknown>
      expect(schema).toBeDefined()
      expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#')
      // Effect Schema uses $ref at root with $defs for type definitions
      expect(schema['$ref']).toBe('#/$defs/MegarepoConfig')
      expect(schema['$defs']).toBeDefined()
      const defs = schema['$defs'] as Record<string, Record<string, unknown>>
      expect(defs['MegarepoConfig']).toBeDefined()
      expect(defs['MegarepoConfig']?.['type']).toBe('object')
    })
  })
})
