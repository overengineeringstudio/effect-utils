import { describe, expect, it } from 'vitest'

import {
  clearLine,
  clearLinesAbove,
  clearToBOL,
  clearToEOL,
  cursorDown,
  cursorToColumn,
  cursorToStart,
  cursorUp,
  hideCursor,
  rewriteLine,
  showCursor,
} from './ansi.ts'

describe('ansi', () => {
  describe('cursor movement', () => {
    it('cursorUp generates correct escape code', () => {
      expect(cursorUp(1)).toBe('\x1b[1A')
      expect(cursorUp(5)).toBe('\x1b[5A')
      expect(cursorUp(0)).toBe('')
    })

    it('cursorDown generates correct escape code', () => {
      expect(cursorDown(1)).toBe('\x1b[1B')
      expect(cursorDown(3)).toBe('\x1b[3B')
      expect(cursorDown(0)).toBe('')
    })

    it('cursorToStart is carriage return', () => {
      expect(cursorToStart).toBe('\r')
    })

    it('cursorToColumn generates correct escape code', () => {
      expect(cursorToColumn(1)).toBe('\x1b[1G')
      expect(cursorToColumn(10)).toBe('\x1b[10G')
    })
  })

  describe('line clearing', () => {
    it('clearToEOL clears from cursor to end of line', () => {
      expect(clearToEOL).toBe('\x1b[K')
    })

    it('clearToBOL clears from cursor to beginning of line', () => {
      expect(clearToBOL).toBe('\x1b[1K')
    })

    it('clearLine clears entire line', () => {
      expect(clearLine).toBe('\x1b[2K')
    })
  })

  describe('cursor visibility', () => {
    it('hideCursor generates correct escape code', () => {
      expect(hideCursor).toBe('\x1b[?25l')
    })

    it('showCursor generates correct escape code', () => {
      expect(showCursor).toBe('\x1b[?25h')
    })
  })

  describe('compound operations', () => {
    it('rewriteLine moves up, goes to start, and clears', () => {
      expect(rewriteLine(2)).toBe('\x1b[2A\r\x1b[K')
      expect(rewriteLine(0)).toBe('\r\x1b[K')
    })

    it('clearLinesAbove clears multiple lines', () => {
      const result = clearLinesAbove(3)
      // Should move up and clear 3 times
      expect(result).toBe('\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K')
    })

    it('clearLinesAbove with 0 returns empty string', () => {
      expect(clearLinesAbove(0)).toBe('')
    })
  })
})
