/**
 * Sync Renderer Unit Tests
 *
 * Tests the sync output rendering including generator file display.
 */

import { describe, expect, it } from 'vitest'

import { renderSync } from './sync-renderer.ts'

// =============================================================================
// Test Fixtures
// =============================================================================

const baseInput = {
  name: 'test/workspace',
  root: '/test/workspace/',
  nestedMegarepos: [] as string[],
  deep: false,
  dryRun: false,
  frozen: false,
}

// =============================================================================
// Generator Output Tests
// =============================================================================

describe('renderSync', () => {
  describe('generated files section', () => {
    it('should show "Generated:" section with checkmarks when files provided', () => {
      const lines = renderSync({
        ...baseInput,
        results: [{ name: 'lib1', status: 'already_synced' }],
        generatedFiles: ['.envrc.generated.megarepo', '.vscode/megarepo.code-workspace'],
      })

      const output = lines.join('\n')
      expect(output).toContain('Generated:')
      expect(output).toContain('.envrc.generated.megarepo')
      expect(output).toContain('.vscode/megarepo.code-workspace')
    })

    it('should show "Would generate:" section in dry-run mode', () => {
      const lines = renderSync({
        ...baseInput,
        dryRun: true,
        results: [{ name: 'lib1', status: 'already_synced' }],
        generatedFiles: ['.envrc.generated.megarepo'],
      })

      const output = lines.join('\n')
      expect(output).toContain('Would generate:')
      expect(output).toContain('.envrc.generated.megarepo')
      expect(output).not.toContain('Generated:')
    })

    it('should not show generator section when no files provided', () => {
      const lines = renderSync({
        ...baseInput,
        results: [{ name: 'lib1', status: 'already_synced' }],
      })

      const output = lines.join('\n')
      expect(output).not.toContain('Generated:')
      expect(output).not.toContain('Would generate:')
    })

    it('should not show generator section when empty array provided', () => {
      const lines = renderSync({
        ...baseInput,
        results: [{ name: 'lib1', status: 'already_synced' }],
        generatedFiles: [],
      })

      const output = lines.join('\n')
      expect(output).not.toContain('Generated:')
      expect(output).not.toContain('Would generate:')
    })

    it('should show generator section before nested megarepos hint', () => {
      const lines = renderSync({
        ...baseInput,
        results: [{ name: 'lib1', status: 'already_synced' }],
        nestedMegarepos: ['lib1'],
        generatedFiles: ['.vscode/megarepo.code-workspace'],
      })

      const output = lines.join('\n')
      const generatedIndex = output.indexOf('Generated:')
      const nestedIndex = output.indexOf('nested megarepos')

      expect(generatedIndex).toBeGreaterThan(-1)
      expect(nestedIndex).toBeGreaterThan(-1)
      expect(generatedIndex).toBeLessThan(nestedIndex)
    })
  })

  describe('basic rendering', () => {
    it('should render header with name and root', () => {
      const lines = renderSync({
        ...baseInput,
        results: [],
      })

      const output = lines.join('\n')
      expect(output).toContain('test/workspace')
      expect(output).toContain('/test/workspace/')
    })

    it('should show mode indicators when flags are set', () => {
      const lines = renderSync({
        ...baseInput,
        dryRun: true,
        frozen: true,
        results: [],
      })

      const output = lines.join('\n')
      expect(output).toContain('dry run')
      expect(output).toContain('frozen')
    })
  })
})
