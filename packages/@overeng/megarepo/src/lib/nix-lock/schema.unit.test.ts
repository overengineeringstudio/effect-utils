import { describe, expect, it } from 'vitest'

import { convertLockedInputToGitHub } from './schema.ts'

describe('convertLockedInputToGitHub', () => {
  it('should convert git-type with git+ssh GitHub URL', () => {
    const result = convertLockedInputToGitHub({
      type: 'git',
      url: 'git+ssh://git@github.com/owner/repo.git',
      rev: 'abc123',
      ref: 'main',
      narHash: 'sha256-xxx',
      lastModified: 1234567890,
    })
    expect(result).toMatchInlineSnapshot(`
      {
        "lastModified": 1234567890,
        "narHash": "sha256-xxx",
        "owner": "owner",
        "ref": "main",
        "repo": "repo",
        "rev": "abc123",
        "type": "github",
      }
    `)
  })

  it('should convert git-type with git+https GitHub URL', () => {
    const result = convertLockedInputToGitHub({
      type: 'git',
      url: 'https://github.com/owner/repo',
      rev: 'def456',
    })
    expect(result).toMatchInlineSnapshot(`
      {
        "owner": "owner",
        "repo": "repo",
        "rev": "def456",
        "type": "github",
      }
    `)
  })

  it('should drop shallow and submodules fields', () => {
    const result = convertLockedInputToGitHub({
      type: 'git',
      url: 'git+ssh://git@github.com/owner/repo',
      rev: 'abc',
      shallow: true,
      submodules: false,
    })
    expect(result).not.toHaveProperty('shallow')
    expect(result).not.toHaveProperty('submodules')
    expect(result).not.toHaveProperty('url')
    expect(result).toHaveProperty('owner', 'owner')
    expect(result).toHaveProperty('repo', 'repo')
  })

  it('should return undefined for non-GitHub git URLs', () => {
    expect(
      convertLockedInputToGitHub({
        type: 'git',
        url: 'https://gitlab.com/owner/repo',
        rev: 'abc',
      }),
    ).toBeUndefined()
  })

  it('should return undefined for already-github type', () => {
    expect(
      convertLockedInputToGitHub({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
        rev: 'abc',
      }),
    ).toBeUndefined()
  })

  it('should return undefined for path type', () => {
    expect(
      convertLockedInputToGitHub({
        type: 'path',
        path: '/nix/store/abc',
      }),
    ).toBeUndefined()
  })

  it('should strip revCount when converting git to github', () => {
    const result = convertLockedInputToGitHub({
      type: 'git',
      url: 'https://github.com/livestorejs/livestore',
      rev: 'abc123',
      ref: 'dev',
      revCount: 3081,
    })
    expect(result).toBeDefined()
    expect(result!['type']).toBe('github')
    expect(result).not.toHaveProperty('revCount')
    expect(result).toMatchInlineSnapshot(`
      {
        "owner": "livestorejs",
        "ref": "dev",
        "repo": "livestore",
        "rev": "abc123",
        "type": "github",
      }
    `)
  })

  it('should preserve dir param from URL query string', () => {
    const result = convertLockedInputToGitHub({
      type: 'git',
      url: 'git+ssh://git@github.com/owner/repo.git?dir=nix/flake&ref=main',
      rev: 'abc123',
    })
    expect(result).toMatchInlineSnapshot(`
      {
        "dir": "nix/flake",
        "owner": "owner",
        "repo": "repo",
        "rev": "abc123",
        "type": "github",
      }
    `)
  })

  it('should work for original sections (minimal fields)', () => {
    const result = convertLockedInputToGitHub({
      type: 'git',
      url: 'git+ssh://git@github.com/org/repo.git',
      ref: 'main',
    })
    expect(result).toMatchInlineSnapshot(`
      {
        "owner": "org",
        "ref": "main",
        "repo": "repo",
        "type": "github",
      }
    `)
  })
})
