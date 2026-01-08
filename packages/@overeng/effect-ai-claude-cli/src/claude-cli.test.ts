import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { classifyError } from './claude-cli.ts'
import {
  ClaudeCliAuthError,
  ClaudeCliExitError,
  ClaudeCliNotLoggedInError,
  ClaudeCliRateLimitError,
} from './errors.ts'

describe('classifyError', () => {
  describe('ClaudeCliNotLoggedInError detection', () => {
    it('detects "not logged in" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Not logged in',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliNotLoggedInError)
      expect(error.message).toContain('login')
    })

    it('detects "login required" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: login required',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliNotLoggedInError)
    })

    it('detects "please log in" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Please log in to continue',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliNotLoggedInError)
    })

    it('detects "authentication required" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Authentication required',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliNotLoggedInError)
    })

    it('is case insensitive', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'NOT LOGGED IN',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliNotLoggedInError)
    })
  })

  describe('ClaudeCliAuthError detection', () => {
    it('detects "unauthorized" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Unauthorized access',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliAuthError)
      expect(error.message).toContain('authentication')
    })

    it('detects "token expired" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: '',
        stderr: 'Token expired',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliAuthError)
    })

    it('detects "invalid token" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Invalid token provided',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliAuthError)
    })

    it('detects "session expired" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Session expired',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliAuthError)
    })
  })

  describe('ClaudeCliRateLimitError detection', () => {
    it('detects "rate limit" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Rate limit exceeded',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliRateLimitError)
      expect(error.message).toContain('Rate limited')
    })

    it('detects "too many requests" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: '',
        stderr: 'Too many requests',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliRateLimitError)
    })

    it('detects "quota exceeded" message', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'Quota exceeded',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliRateLimitError)
    })
  })

  describe('ClaudeCliExitError fallback', () => {
    it('returns ClaudeCliExitError for unrecognized errors', () => {
      const error = classifyError({
        exitCode: 42,
        stdout: 'Some random error',
        stderr: 'stderr output',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliExitError)
      expect(error._tag).toBe('ClaudeCliExitError')
    })

    it('includes exit code in error', () => {
      const error = classifyError({
        exitCode: 42,
        stdout: 'error',
        stderr: '',
        command: 'claude -p',
      })
      expect(error._tag).toBe('ClaudeCliExitError')
      if (error._tag === 'ClaudeCliExitError') {
        expect(error.exitCode).toBe(42)
      }
    })

    it('includes stdout in error', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: 'stdout content',
        stderr: '',
        command: 'claude -p',
      })
      expect(error._tag).toBe('ClaudeCliExitError')
      if (error._tag === 'ClaudeCliExitError') {
        expect(error.stdout).toContain('stdout content')
      }
    })

    it('includes stderr in error', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: '',
        stderr: 'stderr content',
        command: 'claude -p',
      })
      expect(error._tag).toBe('ClaudeCliExitError')
      if (error._tag === 'ClaudeCliExitError') {
        expect(error.stderr).toContain('stderr content')
      }
    })

    it('includes command in error', () => {
      const error = classifyError({
        exitCode: 1,
        stdout: '',
        stderr: '',
        command: 'claude -p --model opus',
      })
      expect(error._tag).toBe('ClaudeCliExitError')
      if (error._tag === 'ClaudeCliExitError') {
        expect(error.command).toBe('claude -p --model opus')
      }
    })

    it('truncates long output', () => {
      const longOutput = 'x'.repeat(25000)
      const error = classifyError({
        exitCode: 1,
        stdout: longOutput,
        stderr: '',
        command: 'claude -p',
      })
      expect(error._tag).toBe('ClaudeCliExitError')
      if (error._tag === 'ClaudeCliExitError') {
        expect(error.stdout.length).toBeLessThan(25000)
        expect(error.stdout).toContain('truncated')
      }
    })
  })

  describe('error detection priority', () => {
    it('prefers login errors over auth errors', () => {
      // "not logged in" should take precedence
      const error = classifyError({
        exitCode: 1,
        stdout: 'not logged in unauthorized',
        stderr: '',
        command: 'claude -p',
      })
      expect(error).toBeInstanceOf(ClaudeCliNotLoggedInError)
    })

    it('checks both stdout and stderr', () => {
      const error1 = classifyError({
        exitCode: 1,
        stdout: 'not logged in',
        stderr: '',
        command: 'claude -p',
      })
      const error2 = classifyError({
        exitCode: 1,
        stdout: '',
        stderr: 'not logged in',
        command: 'claude -p',
      })
      expect(error1).toBeInstanceOf(ClaudeCliNotLoggedInError)
      expect(error2).toBeInstanceOf(ClaudeCliNotLoggedInError)
    })
  })
})

describe('error types', () => {
  it('ClaudeCliNotLoggedInError has correct tag', () => {
    const error = new ClaudeCliNotLoggedInError({ message: 'test' })
    expect(error._tag).toBe('ClaudeCliNotLoggedInError')
  })

  it('ClaudeCliAuthError has correct tag', () => {
    const error = new ClaudeCliAuthError({ message: 'test' })
    expect(error._tag).toBe('ClaudeCliAuthError')
  })

  it('ClaudeCliRateLimitError has correct tag', () => {
    const error = new ClaudeCliRateLimitError({ message: 'test' })
    expect(error._tag).toBe('ClaudeCliRateLimitError')
  })

  it('ClaudeCliExitError has correct tag', () => {
    const error = new ClaudeCliExitError({
      message: 'test',
      exitCode: 1,
      stdout: '',
      stderr: '',
      command: 'claude',
    })
    expect(error._tag).toBe('ClaudeCliExitError')
  })
})
