import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tsconfigJson, type GenieContext } from '../mod.ts'

const mockGenieContext: GenieContext = {
  location: 'packages/@test/package',
  cwd: '/workspace',
}

describe('tsconfigJson', () => {
  it('returns GenieOutput with data and stringify', () => {
    const result = tsconfigJson({
      compilerOptions: {
        strict: true,
        target: 'ES2024',
      },
      include: ['src/**/*.ts'],
    })

    expect(result.data).toEqual({
      compilerOptions: {
        strict: true,
        target: 'ES2024',
      },
      include: ['src/**/*.ts'],
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON', () => {
    const result = tsconfigJson({
      compilerOptions: {
        strict: true,
      },
      include: ['src/**/*.ts'],
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.compilerOptions.strict).toBe(true)
    expect(parsed.include).toEqual(['src/**/*.ts'])
  })

  describe('extends warning', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('logs warning when extends is provided', () => {
      tsconfigJson({
        extends: '../tsconfig.base.json',
        compilerOptions: { strict: true },
      })

      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extends'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not recommended'))
    })

    it('logs warning when extends is an array', () => {
      tsconfigJson({
        extends: ['../tsconfig.base.json', '../tsconfig.node.json'],
        compilerOptions: { strict: true },
      })

      expect(warnSpy).toHaveBeenCalledOnce()
    })

    it('does not log warning when extends is not provided', () => {
      tsconfigJson({
        compilerOptions: { strict: true },
        include: ['src/**/*.ts'],
      })

      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})
