import { Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GitCommandError,
  gitCommandTimeoutMillis,
  isNetworkGitCommand,
  isTransientGitError,
  parseGitRemoteUrl,
  type ParsedGitRemote,
} from './git.ts'

describe('git', () => {
  describe('parseGitRemoteUrl', () => {
    describe('SSH URLs', () => {
      it('should parse standard SSH URL', () => {
        const result = parseGitRemoteUrl('git@github.com:owner/repo.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'owner',
          repo: 'repo',
        } satisfies ParsedGitRemote)
      })

      it('should parse SSH URL without .git suffix', () => {
        const result = parseGitRemoteUrl('git@github.com:owner/repo')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'owner',
          repo: 'repo',
        })
      })

      it('should parse GitLab SSH URL', () => {
        const result = parseGitRemoteUrl('git@gitlab.com:mygroup/myproject.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'gitlab.com',
          owner: 'mygroup',
          repo: 'myproject',
        })
      })

      it('should parse custom host SSH URL', () => {
        const result = parseGitRemoteUrl('git@git.example.com:team/project.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'git.example.com',
          owner: 'team',
          repo: 'project',
        })
      })

      it('should handle repo names with hyphens', () => {
        const result = parseGitRemoteUrl('git@github.com:owner/my-cool-repo.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'owner',
          repo: 'my-cool-repo',
        })
      })

      it('should handle owner names with hyphens', () => {
        const result = parseGitRemoteUrl('git@github.com:my-org/repo.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'my-org',
          repo: 'repo',
        })
      })
    })

    describe('HTTPS URLs', () => {
      it('should parse standard HTTPS URL', () => {
        const result = parseGitRemoteUrl('https://github.com/owner/repo.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'owner',
          repo: 'repo',
        })
      })

      it('should parse HTTPS URL without .git suffix', () => {
        const result = parseGitRemoteUrl('https://github.com/owner/repo')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'owner',
          repo: 'repo',
        })
      })

      it('should parse HTTP URL', () => {
        const result = parseGitRemoteUrl('http://github.com/owner/repo.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'github.com',
          owner: 'owner',
          repo: 'repo',
        })
      })

      it('should parse GitLab HTTPS URL', () => {
        const result = parseGitRemoteUrl('https://gitlab.com/mygroup/myproject.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'gitlab.com',
          owner: 'mygroup',
          repo: 'myproject',
        })
      })

      it('should parse custom host HTTPS URL', () => {
        const result = parseGitRemoteUrl('https://git.example.com/team/project.git')
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({
          host: 'git.example.com',
          owner: 'team',
          repo: 'project',
        })
      })
    })

    describe('invalid URLs', () => {
      it('should return None for empty string', () => {
        const result = parseGitRemoteUrl('')
        expect(Option.isNone(result)).toBe(true)
      })

      it('should return None for plain text', () => {
        const result = parseGitRemoteUrl('not-a-url')
        expect(Option.isNone(result)).toBe(true)
      })

      it('should return None for local path', () => {
        const result = parseGitRemoteUrl('/local/path/to/repo')
        expect(Option.isNone(result)).toBe(true)
      })

      it('should return None for file:// URL', () => {
        const result = parseGitRemoteUrl('file:///path/to/repo.git')
        expect(Option.isNone(result)).toBe(true)
      })

      it('should return None for SSH URL without owner', () => {
        const result = parseGitRemoteUrl('git@github.com:repo.git')
        expect(Option.isNone(result)).toBe(true)
      })

      it('should return None for HTTPS URL without owner', () => {
        const result = parseGitRemoteUrl('https://github.com/repo.git')
        expect(Option.isNone(result)).toBe(true)
      })
    })
  })

  describe('isTransientGitError', () => {
    const mkError = (stderr: string) =>
      new GitCommandError({ args: ['fetch'], exitCode: 128, stderr })

    it.each([
      'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
      'fatal: unable to access: Could not resolve host: github.com',
      'fatal: unable to access: Failed to connect: Connection refused',
      'fatal: the remote end hung up unexpectedly',
      'error: RPC failed; curl error 56 GnuTLS_handshake failed',
      'fatal: unable to access: SSL_connect error',
      'fatal: unable to access: Connection timed out',
      'fatal: unable to access: Connection reset by peer',
      'fatal: unexpected disconnect while reading sideband packet',
      'error: RPC failed; curl error 35 SSL handshake failure',
      'error: RPC failed; result=22, HTTP code = 500 gnutls_record_recv: unexpected eof',
      'fatal: unable to access: SSL_read: connection reset',
      'error: RPC failed; curl 18 transfer closed with outstanding read data remaining',
    ])('should classify as transient: %s', (stderr) => {
      expect(isTransientGitError(mkError(stderr))).toBe(true)
    })

    it.each([
      'fatal: repository not found',
      'fatal: could not read Username: terminal prompts disabled',
      'fatal: Authentication failed',
      "fatal: destination path 'repo' already exists and is not an empty directory",
      "fatal: ambiguous argument 'nonexistent': unknown revision",
      'ERROR: Permission denied (publickey)',
      'Host key verification failed',
      'fatal: unable to access: SSL certificate problem: certificate rejected',
    ])('should classify as non-transient: %s', (stderr) => {
      expect(isTransientGitError(mkError(stderr))).toBe(false)
    })
  })

  describe('isNetworkGitCommand', () => {
    it.each([['clone'], ['fetch'], ['pull'], ['push'], ['ls-remote']])(
      'classifies %s as network',
      (sub) => {
        expect(isNetworkGitCommand([sub, '--flag', 'arg'])).toBe(true)
      },
    )

    it.each([['status'], ['rev-parse'], ['worktree'], ['config'], ['remote'], ['checkout']])(
      'classifies %s as local',
      (sub) => {
        expect(isNetworkGitCommand([sub, 'x'])).toBe(false)
      },
    )

    it('classifies empty args as local', () => {
      expect(isNetworkGitCommand([])).toBe(false)
    })

    it('skips leading global options when locating the subcommand', () => {
      // `-c name=value` / `-C <path>` consume a following value arg
      expect(isNetworkGitCommand(['-c', 'http.extraHeader=x', 'clone', 'url', 'target'])).toBe(true)
      expect(isNetworkGitCommand(['-C', '/repo', 'fetch', '--prune'])).toBe(true)
      expect(isNetworkGitCommand(['-c', 'a=b', '--namespace', 'ns', 'push'])).toBe(true)
      // `--opt=value` is a single token, skipped as a flag
      expect(isNetworkGitCommand(['--git-dir=/x/.git', 'ls-remote'])).toBe(true)
      // global options before a LOCAL op stay local
      expect(isNetworkGitCommand(['-c', 'a=b', 'status'])).toBe(false)
      // options with no trailing subcommand
      expect(isNetworkGitCommand(['-c', 'a=b'])).toBe(false)
    })
  })

  describe('gitCommandTimeoutMillis', () => {
    const clone = ['clone', '--bare', 'https://example.com/repo', 'target']
    const revParse = ['rev-parse', 'HEAD']

    afterEach(() => {
      delete process.env['MEGAREPO_GIT_NETWORK_TIMEOUT_MS']
    })

    it('defaults: network gets the generous bound, local the fixed one', () => {
      expect(gitCommandTimeoutMillis(clone)).toBe(600_000)
      expect(gitCommandTimeoutMillis(revParse)).toBe(30_000)
    })

    it('classifies through leading global options (`-c … clone` → network)', () => {
      expect(gitCommandTimeoutMillis(['-c', 'http.extraHeader=x', ...clone])).toBe(600_000)
    })

    it('MEGAREPO_GIT_NETWORK_TIMEOUT_MS tunes network only; local stays fixed', () => {
      process.env['MEGAREPO_GIT_NETWORK_TIMEOUT_MS'] = '900000'
      expect(gitCommandTimeoutMillis(clone)).toBe(900_000)
      expect(gitCommandTimeoutMillis(revParse)).toBe(30_000)
    })

    it('ignores an invalid / non-positive network override', () => {
      process.env['MEGAREPO_GIT_NETWORK_TIMEOUT_MS'] = '0'
      expect(gitCommandTimeoutMillis(clone)).toBe(600_000)
      process.env['MEGAREPO_GIT_NETWORK_TIMEOUT_MS'] = 'not-a-number'
      expect(gitCommandTimeoutMillis(clone)).toBe(600_000)
    })
  })
})
