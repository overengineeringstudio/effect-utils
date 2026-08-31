import * as stylex from '@stylexjs/stylex'

/**
 * Semantic design tokens for effect-schema-form-aria.
 *
 * Components consume only these semantic names — never raw colors or sizes.
 * Raw scales (spacing, radii, fontSizes) come from tailwind-stylex; re-anchoring
 * these defaults onto named scale steps is a follow-up design decision that
 * must not require component changes.
 */
export const tokens = stylex.defineVars({
  ink: '#1a1a1a',
  'subtle-ink': '#6b7280',
  'muted-ink': '#9ca3af',
  border: '#e5e7eb',
  input: '#ffffff',
  surface: '#f9fafb',
  'surface-raised': '#f3f4f6',
  primary: '#3b82f6',
  accent: '#3b82f6',
})
