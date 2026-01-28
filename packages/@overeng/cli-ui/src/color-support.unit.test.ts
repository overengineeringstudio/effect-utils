/**
 * Tests for color support detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getColorLevel,
  supportsColor,
  supports256Colors,
  supportsTruecolor,
  forceColorLevel,
  resetColorState,
  type ColorLevel,
} from './color-support.ts'

describe('color-support', () => {
  // Store original env vars
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    resetColorState()
  })

  afterEach(() => {
    process.env = originalEnv
    resetColorState()
  })

  describe('forceColorLevel', () => {
    it('should override detected level when set', () => {
      forceColorLevel('truecolor')
      expect(getColorLevel()).toBe('truecolor')
      expect(supportsColor()).toBe(true)
      expect(supportsTruecolor()).toBe(true)
    })

    it('should allow disabling colors', () => {
      forceColorLevel('none')
      expect(getColorLevel()).toBe('none')
      expect(supportsColor()).toBe(false)
    })

    it('should clear override when set to undefined', () => {
      // Set up a known environment state
      delete process.env.NO_COLOR
      delete process.env.FORCE_COLOR
      delete process.env.COLORTERM
      delete process.env.TERM_PROGRAM
      process.env.TERM = 'dumb'
      resetColorState()

      // First verify detection gives 'none' for dumb terminal
      expect(getColorLevel()).toBe('none')

      // Now force truecolor
      forceColorLevel('truecolor')
      expect(getColorLevel()).toBe('truecolor')

      // Clear override - should go back to detected 'none'
      forceColorLevel(undefined)
      resetColorState() // Also clear cache
      expect(getColorLevel()).toBe('none')
    })
  })

  describe('NO_COLOR', () => {
    it('should disable colors when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1'
      resetColorState()

      expect(getColorLevel()).toBe('none')
      expect(supportsColor()).toBe(false)
    })

    it('should disable colors when NO_COLOR is empty string', () => {
      process.env.NO_COLOR = ''
      resetColorState()

      expect(getColorLevel()).toBe('none')
      expect(supportsColor()).toBe(false)
    })
  })

  describe('FORCE_COLOR', () => {
    it('should enable basic colors with FORCE_COLOR=1', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '1'
      resetColorState()

      expect(getColorLevel()).toBe('basic')
      expect(supportsColor()).toBe(true)
    })

    it('should enable 256 colors with FORCE_COLOR=2', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '2'
      resetColorState()

      expect(getColorLevel()).toBe('256')
      expect(supports256Colors()).toBe(true)
    })

    it('should enable truecolor with FORCE_COLOR=3', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '3'
      resetColorState()

      expect(getColorLevel()).toBe('truecolor')
      expect(supportsTruecolor()).toBe(true)
    })

    it('should disable colors with FORCE_COLOR=0', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '0'
      resetColorState()

      expect(getColorLevel()).toBe('none')
      expect(supportsColor()).toBe(false)
    })

    it('NO_COLOR takes precedence over FORCE_COLOR', () => {
      process.env.NO_COLOR = '1'
      process.env.FORCE_COLOR = '3'
      resetColorState()

      expect(getColorLevel()).toBe('none')
      expect(supportsColor()).toBe(false)
    })
  })

  describe('COLORTERM', () => {
    it('should detect truecolor from COLORTERM=truecolor', () => {
      delete process.env.NO_COLOR
      delete process.env.FORCE_COLOR
      process.env.COLORTERM = 'truecolor'
      resetColorState()

      expect(getColorLevel()).toBe('truecolor')
    })

    it('should detect truecolor from COLORTERM=24bit', () => {
      delete process.env.NO_COLOR
      delete process.env.FORCE_COLOR
      process.env.COLORTERM = '24bit'
      resetColorState()

      expect(getColorLevel()).toBe('truecolor')
    })
  })

  describe('TERM', () => {
    it('should detect 256 colors from xterm-256color', () => {
      delete process.env.NO_COLOR
      delete process.env.FORCE_COLOR
      delete process.env.COLORTERM
      delete process.env.TERM_PROGRAM
      process.env.TERM = 'xterm-256color'
      resetColorState()

      expect(getColorLevel()).toBe('256')
      expect(supports256Colors()).toBe(true)
    })

    it('should detect no colors from dumb terminal', () => {
      delete process.env.NO_COLOR
      delete process.env.FORCE_COLOR
      delete process.env.COLORTERM
      delete process.env.TERM_PROGRAM
      process.env.TERM = 'dumb'
      resetColorState()

      expect(getColorLevel()).toBe('none')
      expect(supportsColor()).toBe(false)
    })
  })

  describe('caching', () => {
    it('should cache the color level', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '2'
      resetColorState()

      const level1 = getColorLevel()
      process.env.FORCE_COLOR = '3' // Change env
      const level2 = getColorLevel() // Should still be cached

      expect(level1).toBe('256')
      expect(level2).toBe('256') // Cached value
    })

    it('resetColorState should clear the cache', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '2'
      resetColorState()

      const level1 = getColorLevel()
      process.env.FORCE_COLOR = '3'
      resetColorState() // Clear cache
      const level2 = getColorLevel()

      expect(level1).toBe('256')
      expect(level2).toBe('truecolor')
    })
  })

  describe('helper functions', () => {
    it('supportsColor returns true for basic level', () => {
      forceColorLevel('basic')
      expect(supportsColor()).toBe(true)
    })

    it('supports256Colors returns true for 256 and truecolor', () => {
      forceColorLevel('basic')
      expect(supports256Colors()).toBe(false)

      forceColorLevel('256')
      expect(supports256Colors()).toBe(true)

      forceColorLevel('truecolor')
      expect(supports256Colors()).toBe(true)
    })

    it('supportsTruecolor returns true only for truecolor', () => {
      forceColorLevel('256')
      expect(supportsTruecolor()).toBe(false)

      forceColorLevel('truecolor')
      expect(supportsTruecolor()).toBe(true)
    })
  })
})
